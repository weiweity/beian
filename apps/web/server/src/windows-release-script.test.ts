import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/windows/release.ps1");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptBytes = readFileSync(scriptPath);
const script = scriptBytes.toString("utf8").replace(/^\uFEFF/, "");
const recoveryPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/windows/release-recover.ps1");
const recoveryBytes = readFileSync(recoveryPath);
const recovery = recoveryBytes.toString("utf8").replace(/^\uFEFF/, "");
const illustratorScriptPaths = [
  "scripts/windows/illustrator-jsx-smoke.ps1",
  "scripts/windows/install-illustrator-agent.ps1",
  "scripts/windows/illustrator-agent.ps1",
] as const;
const windowsNativeGitScripts = new Map<string, string>([
  ["scripts/windows/release.ps1", script],
  ["scripts/windows/release-recover.ps1", recovery],
  ...illustratorScriptPaths.map((relativePath) => [
    relativePath,
    readFileSync(join(repoRoot, relativePath), "utf8").replace(/^\uFEFF/, ""),
  ] as const),
]);
const atomicReplaceScripts = new Map<string, { source: string; expectedCalls: number }>([
  ["scripts/windows/release.ps1", { source: script, expectedCalls: 3 }],
  ["scripts/windows/release-recover.ps1", { source: recovery, expectedCalls: 2 }],
  [
    "scripts/windows/illustrator-agent.ps1",
    {
      source: readFileSync(join(repoRoot, "scripts/windows/illustrator-agent.ps1"), "utf8").replace(/^\uFEFF/, ""),
      expectedCalls: 1,
    },
  ],
]);
const dependencyCheckPath = join(repoRoot, "scripts/windows/release-dependency-check.mjs");
const dependencyCheck = readFileSync(dependencyCheckPath, "utf8");

function indexOf(re: RegExp): number {
  const m = re.exec(script);
  assert.ok(m, `missing ${re}`);
  return m.index;
}

function extractPowerShellCalls(source: string, marker: string): string[] {
  const calls: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) break;
    const open = source.indexOf("(", start + marker.length);
    assert.notEqual(open, -1, `missing opening parenthesis after ${marker}`);

    let depth = 0;
    let quote: "'" | '"' | null = null;
    let escaped = false;
    let end = -1;
    for (let index = open; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "`") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }

    assert.notEqual(end, -1, `unterminated ${marker} call`);
    calls.push(source.slice(start, end));
    cursor = end;
  }

  return calls;
}

describe("windows release.ps1 contract", () => {
  it("passes a true CLR null backup path to every atomic file replacement", () => {
    const nullBackup = "[System.Management.Automation.Language.NullString]::Value";
    const marker = "[System.IO.File]::Replace";

    assert.equal(
      extractPowerShellCalls(`${marker}(\n  $source,\n  $destination,\n  $null\n)`, marker).length,
      1,
      "the contract parser must see multiline replacements",
    );

    for (const [relativePath, { source, expectedCalls }] of atomicReplaceScripts) {
      const calls = extractPowerShellCalls(source, marker);
      assert.equal(calls.length, expectedCalls, `${relativePath} atomic replace call count changed`);
      for (const call of calls) {
        assert.ok(call.includes(nullBackup), `${relativePath} must pass a real CLR null backup path: ${call}`);
        assert.doesNotMatch(
          call,
          /,\s*\$null\s*\)$/,
          `${relativePath} must not let PowerShell 5.1 coerce $null to an empty string path`,
        );
      }
    }

    const qualityWorkflow = readFileSync(join(repoRoot, ".github/workflows/quality.yml"), "utf8");
    assert.match(qualityWorkflow, /^  windows-powershell-contract:\s*$/m);
    assert.match(qualityWorkflow, /^    runs-on: windows-2022\s*$/m);
    assert.match(qualityWorkflow, /\[System\.Management\.Automation\.Language\.NullString\]::Value/);
    assert.doesNotMatch(qualityWorkflow, /runs-on:\s*\[self-hosted,\s*hangzhou\]/);
  });

  it("captures native Git output before inspecting its explicit exit code", () => {
    const earlyStoppingNativePipeline = /(?:Invoke-Git|&\s*git\b|\bgit\s+-C\b)[^\r\n]*\|\s*Select-Object\s+-First\s+1/i;

    for (const [relativePath, source] of windowsNativeGitScripts) {
      assert.doesNotMatch(
        source,
        earlyStoppingNativePipeline,
        `${relativePath} must not truncate a live native Git pipeline`,
      );
    }

    assert.match(script, /function Invoke-GitResult/);
    assert.match(script, /function Get-GitSingleLine/);
    assert.match(
      script,
      /\$lines = @\(& git[\s\S]{0,500}\$exitCode = \$LASTEXITCODE[\s\S]{0,300}ExitCode = \[int\]\$exitCode/,
    );
    assert.doesNotMatch(script, /function Assert-GitOk/);
    assert.doesNotMatch(script, /\$global:LASTEXITCODE/);

    assert.match(recovery, /function Invoke-GitResult/);
    assert.match(recovery, /function Get-GitSingleLine/);
    assert.match(
      recovery,
      /\$lines = @\(& git -C \$RepositoryRoot @GitArgs\)[\s\S]{0,500}\$exitCode = \$LASTEXITCODE[\s\S]{0,300}ExitCode = \[int\]\$exitCode/,
    );
    for (const relativePath of illustratorScriptPaths) {
      const source = windowsNativeGitScripts.get(relativePath) ?? "";
      assert.match(source, /function Get-GitCheckoutIdentity/);
      assert.match(
        source,
        /\$lines = @\(& git -C \$RepositoryRoot rev-parse HEAD 2>\$null\)[\s\S]{0,200}\$exitCode = \$LASTEXITCODE[\s\S]{0,300}\$values = @\(/,
      );
    }
  });

  it("is Hangzhou CD that always stops 8787 before pull", () => {
    assert.equal(scriptBytes[0], 0xef);
    assert.equal(scriptBytes[1], 0xbb);
    assert.equal(scriptBytes[2], 0xbf);
    assert.match(script, /UTF-8 with BOM/);
    assert.match(script, /Hangzhou production CD/);
    assert.match(script, /live pull-while-serving is gone/);
    assert.match(script, /function Fetch-OriginMain/);
    assert.match(script, /"update-ref", "-d", "refs\/remotes\/origin\/main"/);
    assert.match(script, /cannot lock ref 'refs\/remotes\/origin\/main'/);
    assert.match(script, /网络\/401\/Clash 失败不要动 origin\/main/);
    assert.match(script, /^Fetch-OriginMain$/m);
    assert.match(script, /function Invoke-GitFetch/);
    assert.match(script, /NativeCommandError from git stderr/);
    assert.match(script, /\$ErrorActionPreference = "Continue"/);
    assert.ok(indexOf(/^Fetch-OriginMain$/m) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.ok(indexOf(/function Invoke-GitFetch/) < indexOf(/fetch origin \*> \$LogPath/));
    assert.ok(indexOf(/\$ErrorActionPreference = "Continue"/) < indexOf(/fetch origin \*> \$LogPath/));
    assert.match(script, /RepositoryRoot/);
    assert.match(script, /ReleaseSourceDir/);
    assert.match(script, /GIT_OPTIONAL_LOCKS = "0"/);
    assert.ok(indexOf(/function Invoke-GitFetch/) < indexOf(/^Fetch-OriginMain$/m));
    assert.doesNotMatch(script, /Write-Host \$msg/);
    assert.match(script, /Remove-Item \$log -Force/);
    assert.match(script, /Get-Content \$log -Raw -Encoding \$enc/);
    assert.match(script, /throw "git fetch origin 失败 exit=\$code"/);
    assert.ok(indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/) < indexOf(/"merge", "--ff-only", \$TargetSha/));
  });

  it("resets npm-dirty lockfile and refuses other tracked dirt before stopping 8787", () => {
    assert.match(script, /function Restore-NpmLockfileWorktree/);
    assert.match(script, /native Git result contract verified before service stop/);
    assert.ok(indexOf(/^Restore-NpmLockfileWorktree$/m) < indexOf(/工作树有未提交改动，拒绝停 8787/));
    assert.ok(indexOf(/^Restore-NpmLockfileWorktree$/m) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.match(script, /"symbolic-ref", "--quiet", "--short", "HEAD"/);
    assert.match(script, /当前分支不是 main，拒绝切分支或停 8787/);
    assert.doesNotMatch(script, /Invoke-GitChecked[^\n]+@\("(?:checkout|reset)"/);
    assert.ok(indexOf(/工作树有未提交改动，拒绝停 8787/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.ok(indexOf(/本地 main 比 origin\/main 多/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.match(script, /"status", "--porcelain", "--untracked-files=no"/);
    assert.match(script, /"rev-list", "--count", "origin\/main\.\.HEAD"/);
  });

  it("binds the bootstrap, dependency checks, merge, and journal to one immutable target SHA", () => {
    const yml = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../../.github/workflows/hangzhou-release.yml"),
      "utf8",
    );
    assert.match(script, /\[string\]\$TargetSha = ""/);
    assert.match(script, /function Resolve-ReleaseTarget/);
    assert.match(script, /TargetSha 必须是完整的 40 位 Git commit SHA/);
    assert.match(script, /"merge-base", "--is-ancestor", \$resolved, "origin\/main"/);
    assert.match(script, /"merge-base", "--is-ancestor", \$preSha, \$TargetSha/);
    assert.match(script, /过期 workflow 不得回退或部署旁支/);
    assert.match(script, /"merge", "--ff-only", \$TargetSha/);
    assert.match(script, /\$mergedHeadSha = \(Get-GitSingleLine "git rev-parse merged HEAD"/);
    assert.match(script, /\$mergedHeadSha -ne \$TargetSha/);
    assert.match(script, /merge 后 HEAD=.*不是停服前锁定的 TargetSha/);
    assert.doesNotMatch(script, /\$targetSha\b/);
    assert.match(script, /target_sha = \$RequestedTargetSha/);
    assert.match(script, /target_version = \$RequestedTargetVersion/);
    assert.match(script, /git_transaction_target_sha = \$TargetSha/);
    assert.match(recovery, /git_transaction_target_sha/);
    assert.match(recovery, /immutable target SHA/);
    assert.doesNotMatch(script, /"merge", "--ff-only", "origin\/main"/);
    assert.doesNotMatch(script, /Assert-OfflineDependencyHandoff \$preSha "origin\/main"/);
    assert.match(yml, /\?ref=' \+ \[Uri\]::EscapeDataString\(\$env:GITHUB_SHA\)/);
    assert.match(yml, /'-TargetSha',\$env:GITHUB_SHA/);
    const mergeIdx = script.indexOf('"merge", "--ff-only", $TargetSha');
    const secondDependencyCheck = script.lastIndexOf("Assert-OfflineDependencyHandoff $preSha $TargetSha $releasePython");
    const buildIdx = script.indexOf('Set-ReleaseJournalStage "ui_build"');
    assert.ok(mergeIdx >= 0 && secondDependencyCheck > mergeIdx && secondDependencyCheck < buildIdx);
  });

  it("fails closed on dependency changes before stop and never installs during the transaction", () => {
    assert.match(script, /function Get-NpmDependencyGraphFingerprint/);
    assert.match(script, /function Assert-OfflineDependencyHandoff/);
    assert.match(script, /真实 npm 依赖图变化/);
    assert.match(script, /Python requirements 变化/);
    assert.match(script, /Windows Rollup 依赖未预置/);
    assert.match(script, /release-dependency-check\.mjs/);
    assert.match(script, /Get-Command node\.exe/);
    assert.match(dependencyCheck, /JSON\.parse/);
    assert.match(dependencyCheck, /lock\.packages\?\.\[""\]/);
    assert.match(dependencyCheck, /delete lock\.version/);
    assert.match(dependencyCheck, /Object\.keys\(value\)\.sort\(\)/);
    const rootLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
    assert.ok(Object.hasOwn(rootLock.packages, ""), "real npm lockfile must exercise packages[\"\"]");
    const fingerprint = spawnSync(
      process.execPath,
      [dependencyCheckPath, "fingerprint", repoRoot, "HEAD"],
      { encoding: "utf8" },
    );
    assert.equal(fingerprint.status, 0, fingerprint.stderr);
    assert.match(fingerprint.stdout.trim(), /^[0-9a-f]{64}$/);
    assert.ok(indexOf(/Assert-OfflineDependencyHandoff \$preSha \$TargetSha \$releasePython/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.ok(indexOf(/Assert-OfflineDependencyHandoff \$preSha \$TargetSha \$releasePython/) < indexOf(/Set-ReleaseJournalStage "ui_build"/));
    assert.doesNotMatch(script, /\bnpm\s+(?:ci|install)\b/);
    assert.doesNotMatch(script, /pip\s+install/);
    assert.doesNotMatch(recovery, /\bnpm\s+(?:ci|install|run)\b/);
    assert.doesNotMatch(recovery, /pip\s+install/);
    assert.match(script, /Remove-Item Env:GITHUB_TOKEN/);
  });

  it("cleans every pre-journal runtime artifact without masking the original release failure", () => {
    const cleanupStart = indexOf(/function Remove-UnarmedReleaseRuntime/);
    const cleanupEnd = script.indexOf("\nfunction ", cleanupStart + 1);
    const cleanup = script.slice(cleanupStart, cleanupEnd);

    for (const ownedPath of [
      "$ReleaseRecoveryPath",
      "$ReleaseInstallerPath",
      "$ReleaseDependencyCheckPath",
      "$ReleaseLockPath",
      "$ReleaseUiSnapshotDir",
    ]) {
      assert.ok(cleanup.includes(ownedPath), `pre-journal cleanup missing ${ownedPath}`);
    }
    assert.match(cleanup, /\[System\.IO\.File\]::Delete\(\$path\)/);
    assert.match(cleanup, /\[System\.IO\.Directory\]::Delete\(\$ReleaseUiSnapshotDir, \$true\)/);
    assert.match(cleanup, /\[System\.IO\.Directory\]::Delete\(\$ReleaseRuntimeDir, \$false\)/);
    assert.match(cleanup, /catch \{[\s\S]*Write-Warning/);

    const finalCleanup = script.slice(script.lastIndexOf("} finally {"));
    assert.match(finalCleanup, /try \{[\s\S]*Remove-UnarmedReleaseRuntime[\s\S]*catch \{[\s\S]*Write-Warning/);
    assert.doesNotMatch(finalCleanup, /Remove-Item[^\n]+\$ReleaseRuntimeDir/);
  });

  it("arms an independent rollback transaction before stopping", () => {
    assert.equal(recoveryBytes[0], 0xef);
    assert.equal(recoveryBytes[1], 0xbb);
    assert.equal(recoveryBytes[2], 0xbf);
    assert.match(script, /function Arm-ReleaseRecovery/);
    assert.match(script, /function Invoke-ArmedRecovery/);
    assert.match(script, /function Start-BeianWinSwService/);
    assert.match(script, /Restart-Service -Name \$name -Force/);
    assert.match(script, /beian-release-watchdog/);
    assert.match(script, /beian\.release-recovery\.v1/);
    assert.match(script, /Register-ScheduledTask/);
    assert.match(script, /-UserId "SYSTEM" -LogonType ServiceAccount/);
    assert.match(script, /RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
    assert.match(script, /Write-AtomicReleaseJournal/);
    assert.match(script, /recovery_sha256/);
    assert.match(script, /runtime_installer_sha256/);
    assert.match(script, /runtime_dependency_check_sha256/);
    assert.match(script, /ui_snapshot_sha256/);
    assert.match(script, /function Snapshot-UiDist/);
    assert.match(script, /function Get-DirectoryFingerprint/);
    assert.match(script, /last_error = ""/);
    assert.match(script, /release_start_filetime_utc/);
    assert.match(script, /release_lease_id/);
    assert.match(script, /release\.lock/);
    assert.match(script, /\[System\.IO\.FileShare\]::None/);
    assert.doesNotMatch(script, /System\.Threading\.Mutex/);
    assert.doesNotMatch(script, /Global\\BeianReleaseV1/);
    assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
    assert.match(script, /S-1-5-18/);
    assert.match(script, /S-1-5-32-544/);
    assert.doesNotMatch(script, /schtasks \/Create/);
    assert.doesNotMatch(script, /\/SC ONLOGON/);
    assert.doesNotMatch(script, /schtasks \/Run \/TN beian-server-8787/);
    assert.match(script, /pre-stop SHA=.*VERSION=/);
    assert.ok(indexOf(/^  Arm-ReleaseRecovery/m) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.match(script, /Invoke-ArmedRecovery "停服阶段失败"/);
    assert.match(script, /Invoke-ArmedRecovery "升版失败"/);
    assert.ok(indexOf(/Set-ReleaseJournalStage "committed"/) < indexOf(/Disarm-ReleaseRecovery/));

    assert.match(recovery, /beian\.release-recovery\.v1/);
    assert.match(recovery, /release\.lock/);
    assert.match(recovery, /\[System\.IO\.FileShare\]::None/);
    assert.match(recovery, /function Assert-ReleaseJournalContract/);
    const recoveryLockIndex = recovery.indexOf("$releaseLockStream = [System.IO.FileStream]::new");
    const lockedJournalReadIndex = recovery.indexOf("$journal = Read-ReleaseJournal", recoveryLockIndex);
    const lockedJournalContractIndex = recovery.indexOf("Assert-ReleaseJournalContract $journal", lockedJournalReadIndex);
    const lockedReleaseProcessIndex = recovery.indexOf("Test-ReleaseProcess $journal", lockedJournalReadIndex);
    const trustedRootIndex = recovery.indexOf("$root = [System.IO.Path]::GetFullPath", recoveryLockIndex);
    assert.ok(recoveryLockIndex >= 0);
    assert.ok(lockedJournalReadIndex > recoveryLockIndex);
    assert.ok(lockedJournalContractIndex > lockedJournalReadIndex);
    assert.ok(lockedReleaseProcessIndex > lockedJournalReadIndex);
    assert.ok(trustedRootIndex > lockedJournalContractIndex);
    assert.ok(trustedRootIndex > lockedReleaseProcessIndex);
    assert.match(recovery, /release_start_filetime_utc/);
    assert.match(recovery, /release_lease_id/);
    assert.match(recovery, /StartTime\.ToUniversalTime\(\)\.ToFileTimeUtc\(\)/);
    assert.doesNotMatch(recovery, /System\.Threading\.Mutex/);
    assert.doesNotMatch(recovery, /Global\\BeianReleaseV1/);
    assert.match(recovery, /release recovery script hash does not match/);
    assert.match(script, /function Arm-GitMergeTransaction/);
    assert.match(script, /beian\.git-merge-locks\.v1/);
    assert.match(script, /git_transaction_source_stage = "agent_quiesce"/);
    assert.match(script, /git_transaction_baseline = "all-absent"/);
    assert.match(script, /git_transaction_target_sha = \$TargetSha/);
    assert.match(script, /git_transaction_lock_policy_sha256/);
    assert.ok(indexOf(/Arm-GitMergeTransaction/) < indexOf(/"merge", "--ff-only", \$TargetSha/));
    assert.match(recovery, /function Remove-StaleReleaseGitLocks/);
    for (const lock of [
      "index.lock",
      "ORIG_HEAD.lock",
      "HEAD.lock",
      "refs\\heads\\main.lock",
      "logs\\HEAD.lock",
      "logs\\ORIG_HEAD.lock",
      "logs\\refs\\heads\\main.lock",
    ]) {
      assert.ok(script.includes(`"${lock}"`), `release allowlist missing ${lock}`);
      assert.ok(recovery.includes(`"${lock}"`), `recovery allowlist missing ${lock}`);
    }
    assert.match(recovery, /Test-ReleaseProcess \$Journal/);
    assert.match(recovery, /LastWriteTimeUtc -lt \$transactionStarted/);
    assert.match(recovery, /release recovery is waiting for git\.exe to exit before clearing owned locks/);
    assert.match(recovery, /release recovery cannot exclusively claim every owned Git lock/);
    assert.match(recovery, /immutable merge ownership/);
    assert.doesNotMatch(recovery, /\$stage -in @\("merging", "recovering", "recovery_failed"\)/);
    assert.ok(
      recovery.indexOf("Remove-StaleReleaseGitLocks $root $journal")
        < recovery.indexOf('$journal.stage = "recovering"'),
    );
    assert.match(recovery, /if \(-not \[string\]\$latest\.failed_from_stage\)/);
    assert.doesNotMatch(recovery, /Remove-Item[^\n]+\*\.lock/i);
    assert.doesNotMatch(recovery, /Remove-Item[^\n]+\.git[^\n]+-Recurse/i);
    assert.match(recovery, /"reset", "--hard", \$preSha/);
    assert.match(recovery, /restored HEAD does not match/);
    assert.match(recovery, /restored VERSION does not match/);
    assert.match(recovery, /function Restore-UiSnapshot/);
    assert.match(recovery, /UI snapshot fingerprint does not match/);
    assert.match(recovery, /restored UI snapshot failed verification/);
    assert.match(recovery, /offline rollback cannot be proven/);
    assert.match(recovery, /last_error = \[string\]\$_\.Exception\.Message/);
    assert.match(recovery, /Start-BeianService \$preVersion/);
    assert.match(recovery, /function Assert-RecoveryRuntimeIntegrity/);
    assert.match(recovery, /function Assert-RecoveredAgentIdentity/);
    assert.match(recovery, /target_ui_sha256/);
    assert.match(recovery, /function Test-ReleaseControlBinding/);
    assert.match(recovery, /beian\.release\.v1/);
    assert.match(recovery, /Get-ListenerPid 8787/);
    assert.match(recovery, /\[string\]\$control\.version -ne \$ExpectedVersion/);
    assert.match(recovery, /\$listenerPid -ne \$controlPid/);
    assert.match(recovery, /Test-ReleaseControlBinding \$dataRoot \$targetVersion \$false/);
    assert.match(recovery, /Test-ReleaseControlBinding \$dataRoot \$preVersion \$true/);
    assert.match(recovery, /Test-ReleaseControlBinding \$DataRoot \$ExpectedVersion \$true/);
    assert.match(recovery, /Start-BeianService \$preVersion \$dataRoot/);
    const legacyGate = recovery.slice(
      recovery.indexOf("function Enter-LegacyRecoverySafetyGate"),
      recovery.indexOf("function Start-BeianService"),
    );
    assert.ok(legacyGate.length > 0);
    assert.ok(legacyGate.indexOf("Stop-BeianService") < legacyGate.indexOf("illustrator-fault.json"));
    assert.match(legacyGate, /Get-Process -Name "Illustrator", "AIRobin", "cscript", "wscript"/);
    assert.match(legacyGate, /8787 remains stopped/);
    const legacyGateCalls = [...recovery.matchAll(/^\s+Enter-LegacyRecoverySafetyGate \$dataRoot$/gm)].map(
      (match) => match.index ?? -1,
    );
    const legacyStarts = [...recovery.matchAll(/^\s+Start-BeianService \$preVersion \$dataRoot$/gm)].map(
      (match) => match.index ?? -1,
    );
    assert.equal(legacyGateCalls.length, 2);
    assert.equal(legacyStarts.length, 2);
    assert.ok(legacyGateCalls[0] < legacyStarts[0]);
    assert.ok(legacyGateCalls[1] > legacyStarts[0]);
    assert.ok(legacyGateCalls[1] < legacyStarts[1]);
    assert.match(recovery, /stage -eq "committed"/);
    assert.match(recovery, /finalized committed release/);
    assert.ok(recovery.indexOf('"reset", "--hard", $preSha') < recovery.indexOf("Assert-RecoveryRuntimeIntegrity $root $python"));
    assert.ok(recovery.indexOf("Restore-UiSnapshot $uiSnapshot") < recovery.indexOf('"reset", "--hard", $preSha'));
    assert.match(recovery, /fastRecoveryStage/);
    assert.match(recovery, /-not \[bool\]\$journal\.ui_mutated/);
    assert.match(recovery, /-not \[bool\]\$journal\.agent_mutated/);
    assert.match(recovery, /final recovered UI does not match the armed snapshot/);
    assert.doesNotMatch(recovery, /taskkill\.exe/i);
    assert.doesNotMatch(recovery, /Stop-Process\s+-Name\s+node/i);
  });

  it("does not use PowerShell automatic \$PID", () => {
    assert.doesNotMatch(script, /(?<![\w])\$PID(?![\w])/i);
    assert.match(script, /\$listenerPid/);
    assert.match(script, /\$controlPid/);
  });

  it("consumes Hono's stable readiness contract instead of duplicating the job model", () => {
    assert.match(script, /\$state\.ready -eq \$true/);
    assert.match(script, /blocker_codes/);
    assert.match(script, /release drain 最终复核失败/);
    assert.doesNotMatch(script, /HealthObj\.jobs/);
    assert.doesNotMatch(script, /uploads\.active/);
    assert.doesNotMatch(script, /illustrator-agent\.json/);
  });

  it("proves the installed runtime can cold-start offline before stopping", () => {
    assert.match(script, /function Assert-OfflineRuntimeIntegrity/);
    assert.match(script, /npm installed graph/);
    assert.match(script, /"ls", "--all", "--offline", "--ignore-scripts"/);
    assert.match(script, /node_modules\\\.bin\\tsx\.cmd/);
    assert.match(script, /Hono service entry import/);
    assert.match(script, /apps\/web\/server\/src\/index\.ts/);
    assert.match(script, /typeof m\.app\.fetch/);
    assert.match(script, /\$invokeFailure/);
    assert.doesNotMatch(script, /try \{ & \$Executable @Arguments \*> \$null \} catch \{ \}/);
    assert.match(script, /Vite CLI/);
    assert.match(script, /Rollup native module/);
    assert.match(script, /"Python dependency graph"/);
    assert.match(script, /import app\.cli; import fitz; import openpyxl/);
    assert.ok(indexOf(/Assert-OfflineRuntimeIntegrity \$releasePython/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.match(recovery, /npm installed graph/);
    assert.match(recovery, /Hono service entry import/);
    assert.match(recovery, /apps\/web\/server\/src\/index\.ts/);
    assert.match(recovery, /\$invokeFailure/);
    assert.doesNotMatch(recovery, /try \{ & \$Executable @Arguments \*> \$null \} catch \{ \}/);
    assert.match(recovery, /import app\.cli; import fitz; import openpyxl/);
  });

  it("atomically drains the stable readiness contract before stopping", () => {
    assert.match(script, /function Enter-ReleaseDrain/);
    assert.match(script, /function Promote-ReleaseDrain/);
    assert.match(script, /beian\.release\.v1/);
    assert.match(script, /x-beian-release-token/);
    assert.match(script, /x-beian-release-lease/);
    assert.match(script, /\[Guid\]::NewGuid\(\)\.ToString\("N"\)/);
    assert.match(script, /\$state\.lease_id -ne \$leaseId/);
    assert.match(script, /release drain ready: all new business writes are blocked/);
    assert.match(script, /首次升到 0\.20 必须先进入批准维护窗并停止旧 8787/);
    assert.match(script, /-AllowLegacyOfflineBootstrap/);
    assert.match(script, /offline maintenance bootstrap/);
    assert.match(script, /remove stale release control/);
    assert.match(script, /不拥有当前 8787 listener/);
    assert.match(script, /Get-Process -Id \$controlPid/);
    assert.match(script, /\/api\/internal\/release\/identity/);
    assert.match(script, /\$identity\.instance_id -eq \[string\]\$control\.instance_id/);
    assert.match(script, /\$state\.instance_id -ne \[string\]\$control\.instance_id/);
    assert.match(script, /\$state\.mode -ne "lease"/);
    assert.match(script, /\$state\.mode -ne "transaction"/);
    assert.ok(indexOf(/^  Arm-ReleaseRecovery/m) < indexOf(/\$drain = Promote-ReleaseDrain \$drain/));
    assert.ok(indexOf(/\$drain = Promote-ReleaseDrain \$drain/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.doesNotMatch(script, /AddSeconds\(5\)/);
    assert.doesNotMatch(script, /bootstrap-drain-1/);
    assert.doesNotMatch(script, /bootstrap-drain-2/);
    assert.ok(indexOf(/\$drain = Enter-ReleaseDrain/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.ok(indexOf(/release drain 最终复核失败/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.doesNotMatch(script, /function Assert-PersistedJobsIdle/);
    assert.doesNotMatch(script, /function Assert-AgentHeartbeatSwitchable/);
    assert.doesNotMatch(script, /function Get-RepoWorkerProcesses/);
  });

  it("keeps recovery scheduled until the journal is disarmed", () => {
    assert.match(script, /RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
    assert.doesNotMatch(script, /RepetitionDuration/);
    assert.match(script, /watchdog 会继续重试/);
    assert.match(recovery, /release-journal\.json/);
  });

  it("keeps the target generation drained through smoke and transaction commit", () => {
    assert.match(script, /function Write-StartupDrainFence/);
    assert.match(script, /function Get-TargetReleaseDrain/);
    assert.match(script, /function Open-TargetReleaseDrain/);
    assert.ok(indexOf(/Write-StartupDrainFence \$releaseLeaseId/) < indexOf(/start beian-server/));
    assert.ok(indexOf(/start beian-server/) < indexOf(/\$targetDrain = Get-TargetReleaseDrain/));
    assert.ok(indexOf(/\$targetDrain = Get-TargetReleaseDrain/) < indexOf(/Commit-ReleaseRecovery \$mergedHeadSha \$ver/));
    assert.match(script, /\$state\.ready -ne \$true/);
    assert.match(script, /@\(\$state\.blocker_codes\)\.Count -ne 0/);
    assert.ok(indexOf(/Commit-ReleaseRecovery \$mergedHeadSha \$ver/) < indexOf(/Open-TargetReleaseDrain \$targetDrain \$ver/));
    assert.ok(indexOf(/Open-TargetReleaseDrain \$targetDrain \$ver/) < indexOf(/^  Disarm-ReleaseRecovery$/m));
    assert.match(recovery, /function Open-ReleaseDrain/);
    assert.match(recovery, /function Write-RecoveryStartupDrainFence/);
    assert.match(recovery, /Open-ReleaseDrain \$dataRoot \$targetVersion/);
    assert.match(recovery, /x-beian-release-lease/);
    assert.match(script, /mode = "transaction"/);
    assert.match(recovery, /mode = "transaction"/);
    assert.doesNotMatch(script, /AddSeconds\(120\)/);
    assert.doesNotMatch(recovery, /AddSeconds\(120\)/);
    assert.match(script, /stage -ne "committed"/);
    assert.match(recovery, /committed 以后绝不再切回旧树/);
    assert.match(recovery, /Start-BeianService \$targetVersion \$dataRoot/);
    assert.ok(
      recovery.indexOf("Write-RecoveryStartupDrainFence $dataRoot ([string]$journal.release_lease_id)")
        < recovery.indexOf("Start-BeianService $targetVersion $dataRoot"),
    );
    assert.match(recovery, /if \(\[string\]\$latest\.stage -ne "committed"\)/);
    assert.ok(
      recovery.indexOf('if ([string]$journal.stage -eq "committed")')
        < recovery.indexOf('$journal.stage = "recovering"'),
    );
    const rollbackFence = recovery.lastIndexOf(
      "Write-RecoveryStartupDrainFence $dataRoot ([string]$journal.release_lease_id)",
    );
    const rollbackStart = recovery.lastIndexOf("Start-BeianService $preVersion $dataRoot");
    const rollbackOpen = recovery.lastIndexOf(
      "Open-ReleaseDrain $dataRoot $preVersion ([string]$journal.release_lease_id)",
    );
    assert.ok(rollbackFence > 0 && rollbackFence < rollbackStart);
    assert.ok(rollbackStart < rollbackOpen);
  });

  it("requires a stable offline handoff for the one-time legacy bootstrap", () => {
    assert.match(script, /function Assert-LegacyBootstrapVersion/);
    assert.match(script, /\$preRelease -lt \[version\]"0\.19\.0\.0"/);
    assert.match(script, /\$preRelease -ge \[version\]"0\.20\.0\.0"/);
    assert.match(script, /\$targetRelease -lt \[version\]"0\.20\.0\.0"/);
    assert.match(script, /\$targetRelease -ge \[version\]"0\.21\.0\.0"/);
    assert.match(script, /0\.19\.x -> 0\.20\.x 首次切换/);
    assert.doesNotMatch(script, /targetVersion -ne "0\.20\.0\.0"/);
    assert.match(script, /function Assert-LegacyOfflineIdle/);
    assert.match(script, /Get-LegacyOfflineBlockers/);
    assert.match(script, /active_job:/);
    assert.match(script, /active_upload_session:/);
    assert.match(script, /active_multipart:/);
    assert.match(script, /active_process:/);
    assert.match(script, /Get-CimInstance Win32_Process/);
    assert.match(script, /for \(\$pass = 1; \$pass -le 2; \$pass\+\+\)/);
    assert.ok(indexOf(/^    Assert-LegacyBootstrapVersion \$preVersion \$TargetSha$/m) < indexOf(/^    Assert-LegacyOfflineIdle$/m));
    assert.ok(indexOf(/^    Assert-LegacyOfflineIdle$/m) < indexOf(/^  Arm-ReleaseRecovery/m));
  });

  it("uses only WinSW stop/start and never races a listener PID or touches cloudflared", () => {
    assert.doesNotMatch(script, /taskkill\.exe/i);
    assert.doesNotMatch(script, /Get-Process\s+node/i);
    assert.doesNotMatch(script, /Stop-Process\s+-Name\s+node/i);
    assert.doesNotMatch(script, /cloudflared\s+tunnel/i);
    assert.match(script, /不要动 cloudflared/);
    assert.match(script, /拒绝仅凭瞬时 PID 杀进程/);
    assert.match(script, /Test-PortListening 8787/);
    assert.match(script, /netstat\.exe -ano 探测失败/);
    assert.match(script, /netstat\.exe -ano PID 探测失败/);
    assert.match(script, /\$netstatCode -ne 0 -or \$raw\.Count -eq 0/);
  });

  it("requires WinSW to stop and the listener to disappear before merge", () => {
    assert.match(script, /function Stop-BeianWinSwService/);
    assert.match(script, /Stop-Service -Name \$name -Force/);
    assert.match(script, /WinSW onfailure does not respawn/);
    assert.ok(indexOf(/Stop-Service -Name \$name -Force/) < indexOf(/"merge", "--ff-only", \$TargetSha/));
    assert.ok(indexOf(/release drain 最终复核失败/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.match(script, /WinSW 已 Stopped 但 8787 仍在监听/);
  });

  it("validates WB_DATA_DIR with a directory boundary before stopping", () => {
    assert.ok(indexOf(/Test-DataDirInsideRepo/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
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
    assert.match(script, /Start-BeianWinSwService/);
    assert.match(script, /Restart-Service beian-server-8787 is outside that tree/);
    assert.match(script, /job process tree/);
    assert.doesNotMatch(script, /schtasks \/Create \/TN \$task \/SC ONLOGON/);
    assert.ok(indexOf(/Windows Rollup 依赖未预置/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.ok(indexOf(/Set-ReleaseJournalStage "ui_build"/) < indexOf(/start beian-server/));
  });

  it("reuses a verified offline Python environment and refuses requirements drift before stop", () => {
    assert.match(script, /\$env:WB_PYTHON/);
    assert.match(script, /apps\\web\\backend\\.venv\\Scripts\\python\.exe/);
    assert.match(script, /找不到 Python/);
    assert.match(script, /git diff --quiet \$FromRevision \$ToRevision -- apps\/web\/backend\/requirements\.txt/);
    assert.match(script, /reuse verified offline Python environment/);
    assert.ok(indexOf(/Assert-OfflineDependencyHandoff \$preSha \$TargetSha \$releasePython/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.doesNotMatch(script, /pip\s+install/);
  });

  it("installs the Session 1 Illustrator agent before starting 8787 and rolls its task back with the tree", () => {
    assert.match(script, /function Sync-IllustratorAgentTaskToCurrentTree/);
    assert.match(script, /install-illustrator-agent\.ps1/);
    assert.match(script, /beian-illustrator-agent/);
    assert.match(script, /Set-ReleaseJournalStage "agent_quiesce"/);
    assert.match(script, /\$ReleaseInstallerPath[\s\S]+-Quiesce/);
    assert.match(script, /Unregister-ScheduledTask/);
    assert.match(script, /restored tree has no Illustrator agent/);
    assert.match(script, /Disable-ScheduledTask -TaskName \$taskName -ErrorAction SilentlyContinue/);
    const releaseDisableIdx = script.indexOf(
      "Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue",
    );
    const releaseStopIdx = script.indexOf(
      "Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue",
    );
    assert.ok(releaseDisableIdx >= 0 && releaseStopIdx > releaseDisableIdx);
    assert.ok(indexOf(/Set-ReleaseJournalStage "ui_build"/) < indexOf(/^  Sync-IllustratorAgentTaskToCurrentTree$/m));
    assert.ok(indexOf(/^  Sync-IllustratorAgentTaskToCurrentTree$/m) < indexOf(/start beian-server/));
    const agentMutatedIdx = script.indexOf("$ReleaseJournalState.agent_mutated = $true");
    const agentQuiesceStageIdx = script.indexOf('Set-ReleaseJournalStage "agent_quiesce"');
    const agentQuiesceCallIdx = script.indexOf("-Quiesce", agentQuiesceStageIdx);
    const armGitIdx = script.indexOf("\n  Arm-GitMergeTransaction\n");
    assert.ok(
      agentMutatedIdx >= 0 &&
        agentQuiesceStageIdx > agentMutatedIdx &&
        agentQuiesceCallIdx > agentQuiesceStageIdx &&
        armGitIdx > agentQuiesceCallIdx,
    );
    assert.match(recovery, /treeInstaller/);
    assert.match(recovery, /runtimeInstaller/);
    assert.match(recovery, /-Uninstall/);
    assert.match(recovery, /runtime Illustrator installer hash does not match/);
    assert.match(recovery, /function Stop-IllustratorAgentTaskForRecovery/);
    assert.match(recovery, /& \$runtimeInstaller[\s\S]+-Quiesce/);
    const verifierIdx = recovery.indexOf("function Get-VerifiedRuntimeInstallerForRecovery");
    const verifierHashIdx = recovery.indexOf("Get-FileHash", verifierIdx);
    const verifierReturnIdx = recovery.indexOf("return $runtimeInstaller", verifierIdx);
    const recoveryStopIdx = recovery.indexOf("-Quiesce");
    const recoveryResetIdx = recovery.indexOf('"reset", "--hard", $preSha');
    const restoredInstallerIdx = recovery.indexOf("$treeInstaller =", recoveryResetIdx);
    assert.ok(
      verifierIdx >= 0 &&
        verifierHashIdx > verifierIdx &&
        verifierReturnIdx > verifierHashIdx &&
        recoveryStopIdx > verifierReturnIdx,
    );
    assert.ok(recoveryStopIdx >= 0 && recoveryResetIdx > recoveryStopIdx);
    assert.ok(restoredInstallerIdx > recoveryResetIdx);
  });

  it("hides the InteractiveToken Agent and keeps it alive without racing release stops", () => {
    const installer = windowsNativeGitScripts.get("scripts/windows/install-illustrator-agent.ps1") ?? "";
    const qualityWorkflow = readFileSync(join(repoRoot, ".github/workflows/quality.yml"), "utf8");
    const contract = readFileSync(
      join(repoRoot, "scripts/windows/illustrator-agent-task.contract.ps1"),
      "utf8",
    );

    const nonInteractiveIdx = installer.indexOf('"-NonInteractive"');
    const windowStyleIdx = installer.indexOf('"-WindowStyle", "Hidden"');
    const fileIdx = installer.indexOf('"-File"');
    assert.ok(nonInteractiveIdx >= 0);
    assert.ok(windowStyleIdx >= 0);
    assert.ok(fileIdx > nonInteractiveIdx && fileIdx > windowStyleIdx);

    assert.match(installer, /New-ScheduledTaskSettingsSet @settingsArguments -Hidden/);
    assert.match(installer, /\[switch\]\$Quiesce/);
    assert.match(
      installer,
      /\(\$ClearFaultFence -and \(\$Quiesce -or \$Uninstall\)\)[\s\S]+\(\$Quiesce -and \$Uninstall\)/,
    );
    assert.match(installer, /MultipleInstances = "IgnoreNew"/);
    assert.match(installer, /New-ScheduledTaskTrigger -AtLogOn -User \$InteractiveUser/);
    assert.match(installer, /-Trigger \$taskTriggers/);
    assert.match(installer, /Temporary L1 tasks keep AtLogOn only/);
    assert.match(
      installer,
      /New-ScheduledTaskTrigger `\s+-Once `\s+-At \(Get-Date\)\.AddMinutes\(1\) `\s+-RepetitionInterval \(New-TimeSpan -Minutes 1\)/,
    );
    const expiresBranchIdx = installer.indexOf("if ($ExpiresAt -ne [DateTime]::MinValue)");
    const keepAliveIdx = installer.indexOf("-RepetitionInterval (New-TimeSpan -Minutes 1)");
    assert.ok(expiresBranchIdx >= 0 && keepAliveIdx > expiresBranchIdx);

    const disableIdx = installer.indexOf("Disable-ScheduledTask -TaskName $Name -ErrorAction Stop");
    const stopIdx = installer.indexOf("Stop-ScheduledTask -TaskName $Name -ErrorAction Stop");
    assert.ok(disableIdx >= 0 && stopIdx > disableIdx);
    assert.match(installer, /checkout identity is switching/);
    const lifecycleIdx = installer.indexOf("if ($Quiesce -or $Uninstall)");
    const uninstallGuardIdx = installer.indexOf("if ($Uninstall)", lifecycleIdx);
    const unregisterIdx = installer.indexOf("Unregister-ScheduledTask", lifecycleIdx);
    const quiescedResultIdx = installer.indexOf("ILLUSTRATOR_AGENT_TASK quiesced", lifecycleIdx);
    assert.ok(
      lifecycleIdx >= 0 &&
        uninstallGuardIdx > lifecycleIdx &&
        unregisterIdx > uninstallGuardIdx &&
        quiescedResultIdx > unregisterIdx,
    );

    assert.match(contract, /ILLUSTRATOR_AGENT_TASK_CONTRACT ok/);
    assert.match(contract, /Does not register, start, stop, or disable any production task/);
    assert.match(contract, /\.Replace\("`r`n", "`n"\)/);
    assert.match(contract, /New-ScheduledTaskSettingsSet/);
    assert.match(contract, /System\.Management\.Automation\.Language\.Parser/);
    assert.match(contract, /System\.Management\.Automation\.Language\.CommandAst/);
    assert.match(contract, /"Set-ScheduledTask"/);
    assert.match(contract, /ConvertTo-WindowsPowerShell5Ast \$release "release"/);
    assert.match(contract, /ConvertTo-WindowsPowerShell5Ast \$recovery "recovery"/);
    assert.match(contract, /persistent task must have exactly two triggers/);
    assert.match(contract, /temporary task must have exactly one AtLogOn trigger/);
    const windowsJobStart = qualityWorkflow.indexOf("windows-powershell-contract:");
    const windowsJobEnd = qualityWorkflow.indexOf("\n  quality:", windowsJobStart);
    assert.ok(windowsJobStart >= 0 && windowsJobEnd > windowsJobStart);
    const windowsJob = qualityWorkflow.slice(windowsJobStart, windowsJobEnd);
    assert.match(windowsJob, /actions\/checkout@v4/);
    assert.match(windowsJob, /illustrator-agent-task\.contract\.ps1/);
    assert.match(windowsJob, /monitor-task\.contract\.ps1/);
    assert.doesNotMatch(windowsJob, /self-hosted/);
  });

  it("keeps the Hangzhou monitor task off the Illustrator agent and off Stop-Service", () => {
    const monitorInstaller = readFileSync(join(repoRoot, "scripts/windows/install-monitor.ps1"), "utf8");
    const monitorContract = readFileSync(join(repoRoot, "scripts/windows/monitor-task.contract.ps1"), "utf8");
    assert.match(monitorInstaller, /TaskName = "beian-monitor-local"/);
    assert.match(monitorInstaller, /UserId "SYSTEM"/);
    assert.match(monitorInstaller, /host\.mjs/);
    assert.match(monitorInstaller, /UTF8Encoding \$false/);
    assert.match(monitorInstaller, /ReadAllBytes/);
    assert.doesNotMatch(monitorInstaller, /Stop-Service/);
    assert.doesNotMatch(monitorInstaller, /beian-illustrator-agent/);
    assert.doesNotMatch(script, /install-monitor\.ps1/);
    assert.match(monitorContract, /MONITOR_TASK_CONTRACT ok/);
    assert.match(monitorContract, /must not stop Windows services/);
  });

  it("keeps one-shot structure export off Stop-Service and Illustrator Session 0", () => {
    const exportOne = readFileSync(join(repoRoot, "scripts/windows/export-one-structure.ps1"), "utf8");
    assert.match(exportOne, /export_one_structure\.py/);
    assert.match(exportOne, /Does not stop beian-server-8787/);
    assert.doesNotMatch(exportOne, /Stop-Service/);
    assert.doesNotMatch(exportOne, /beian-illustrator-agent/);
    assert.doesNotMatch(script, /export-one-structure\.ps1/);
    assert.match(exportOne, /Parameter\(Mandatory = \$true\)\]\[string\]\$Sha256/);
    assert.match(exportOne, /C:\\supply\\data\\a02-samples/);
    assert.match(exportOne, /\[int\]\$Timeout = 1260/);
    assert.match(exportOne, /\[char\]0x5370/);
    assert.match(exportOne, /\[char\]0x5237/);
    assert.match(exportOne, /\[char\]0x5200/);
    assert.match(exportOne, /\[char\]0x7EBF/);
    assert.doesNotMatch(exportOne, /[\u4e00-\u9fff]/);
    assert.match(exportOne, /\$ErrorActionPreference = "Stop"/);
    assert.match(exportOne, /\$env:WB_PYTHON/);
    assert.match(exportOne, /apps\\web\\backend\\.venv\\Scripts\\python\.exe/);
    assert.match(exportOne, /PathType Leaf/);
    assert.match(exportOne, /throw "python missing: \$py"/);
    assert.match(exportOne, /throw "export_one_structure\.py missing"/);
    assert.match(exportOne, /--source-dir \$SourceDir/);
    assert.match(exportOne, /--sha256 \$Sha256/);
    assert.match(exportOne, /--out-dir \$OutDir/);
    assert.match(exportOne, /--timeout \$Timeout/);
    assert.match(exportOne, /--print-layers \$PrintLayers/);
    assert.match(exportOne, /--proposal-layers \$ProposalLayers/);
    assert.match(exportOne, /exit \$LASTEXITCODE/);
    assert.doesNotMatch(exportOne, /--dry-run/);
    assert.doesNotMatch(exportOne, /cloudflared\s+tunnel/i);
    assert.doesNotMatch(exportOne, /taskkill/i);
    assert.doesNotMatch(exportOne, /Stop-Process/i);
    assert.doesNotMatch(exportOne, /Unregister-ScheduledTask/);
  });

  it("Actions runner downloads an exact-commit bootstrap without mutating the production index", () => {
    const ymlPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../.github/workflows/hangzhou-release.yml");
    const yml = readFileSync(ymlPath, "utf8");
    assert.match(yml, /shell: cmd/);
    assert.match(yml, /api\.github\.com\/repos/);
    assert.match(yml, /application\/vnd\.github\.raw\+json/);
    assert.match(yml, /GITHUB_SHA/);
    assert.match(yml, /RUNNER_TEMP/);
    assert.match(yml, /Invoke-WebRequest[^\n]+-OutFile/);
    assert.match(yml, /'-RepositoryRoot','D:\\beian'/);
    assert.match(yml, /'-ReleaseSourceDir',\$dir/);
    assert.match(yml, /'-TargetSha',\$env:GITHUB_SHA/);
    assert.match(yml, /^\s+shell: cmd\s*$/m);
    assert.doesNotMatch(yml, /^\s+shell: powershell\s*$/m);
    assert.match(yml, /if: failure\(\)/);
    assert.match(yml, /^\s+push:\s*$/m);
    assert.match(yml, /^\s+branches: \[main\]\s*$/m);
    assert.doesNotMatch(yml, /^\s+workflow_dispatch:\s*$/m);
    assert.doesNotMatch(yml, /allow_legacy_offline_bootstrap:/);
    assert.match(yml, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
    assert.match(yml, /github\.run_attempt > 1/);
    assert.match(yml, /ALLOW_LEGACY_OFFLINE_BOOTSTRAP:/);
    assert.match(yml, /ALLOW_LEGACY_OFFLINE_BOOTSTRAP -eq 'true'/);
    assert.match(yml, /-AllowLegacyOfflineBootstrap/);
    assert.match(yml, /sc start beian-server-8787/);
    assert.match(yml, /1056/);
    assert.match(yml, /ERROR_SERVICE_ALREADY_RUNNING/);
    assert.match(yml, /find "RUNNING"/);
    assert.match(yml, /release-journal\.json/);
    assert.match(yml, /release-recover\.ps1/);
    assert.match(yml, /-TaskName beian-release-watchdog -Force/);
    assert.doesNotMatch(yml, /schtasks \/Run \/TN beian-server-8787/);
    assert.doesNotMatch(yml, /ONLOGON/);
    const startIdx = yml.indexOf("sc start beian-server-8787");
    const runningIdx = yml.indexOf('find "RUNNING"');
    assert.ok(runningIdx >= 0 && startIdx >= 0 && runningIdx < startIdx);
    assert.match(yml, /^\s+GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}\s*$/m);
    assert.match(yml, /Authorization=\('Bearer ' \+ \$env:GITHUB_TOKEN\)/);
    assert.doesNotMatch(yml, /git -C D:\\beian\s+(?:checkout|reset|restore)/i);
    assert.doesNotMatch(yml, /D:\\beian\\scripts\\windows\\release\.ps1/);
    const downloadIdx = yml.indexOf("Invoke-WebRequest");
    const runIdx = yml.indexOf("'-RepositoryRoot','D:\\beian'");
    const failIdx = yml.indexOf("if: failure()");
    assert.ok(downloadIdx >= 0 && runIdx > downloadIdx && failIdx > runIdx);
    assert.doesNotMatch(yml, /echo[^\n]*GITHUB_TOKEN/i);
  });

  it("uses GITHUB_TOKEN for git when Actions provides it, never prints the token", () => {
    assert.match(script, /function Invoke-GitResult/);
    assert.match(script, /function Get-GithubAuthHeader/);
    assert.match(script, /x-access-token:/);
    assert.match(script, /ToBase64String/);
    assert.match(script, /http.extraheader=\$AuthHeader/);
    assert.doesNotMatch(script, /http.extraheader=AUTHORIZATION: bearer/);
    assert.match(script, /function Invoke-GitFetch/);
    assert.match(script, /Invoke-GitFetch -LogPath \$log/);
    assert.match(script, /"merge", "--ff-only", \$TargetSha/);
    assert.doesNotMatch(script, /Write-Host.*GITHUB_TOKEN/);
    assert.match(script, /GITHUB_TOKEN/);
  });

  it("keeps PR code off the Hangzhou runner and runs the Session 1 JSX smoke inside trusted main release", () => {
    const workflowDir = join(repoRoot, ".github/workflows");
    const removedPrWorkflow = join(workflowDir, "windows-packaging-v2.yml");
    assert.equal(existsSync(removedPrWorkflow), false);
    for (const name of readdirSync(workflowDir).filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))) {
      const workflow = readFileSync(join(workflowDir, name), "utf8");
      if (!/runs-on:\s*\[self-hosted, hangzhou\]/.test(workflow)) continue;
      assert.doesNotMatch(workflow, /^\s{2}pull_request:\s*$/m, `${name} must not execute PR code on production`);
      assert.doesNotMatch(workflow, /^\s{2}workflow_dispatch:\s*$/m, `${name} must not execute a selectable ref on production`);
    }

    const smoke = readFileSync(join(repoRoot, "scripts/windows/illustrator-jsx-smoke.ps1"), "utf8");
    assert.match(script, /illustrator-jsx-smoke\.ps1/);
    assert.match(script, /Illustrator Session 1 冒烟失败/);
    const healthIdx = script.indexOf("$targetDrain = Get-TargetReleaseDrain");
    const illustratorSmokeIdx = script.indexOf("& $smokePowerShell");
    const commitIdx = script.indexOf("Commit-ReleaseRecovery $mergedHeadSha $ver");
    assert.ok(healthIdx >= 0 && illustratorSmokeIdx > healthIdx && commitIdx > illustratorSmokeIdx);
    assert.doesNotMatch(script, /illustrator-jsx-smoke\.ps1[^\n]*-BootstrapAgent/);
    assert.match(smoke, /127\.0\.0\.1:8787\/api\/health/);
    assert.match(smoke, /jobs\.illustrator\.running/);
    assert.match(smoke, /illustrator_agent\.py/);
    assert.match(smoke, /"smoke"/);
    assert.match(smoke, /"--timeout", "120"/);
    assert.match(smoke, /"--pipe"/);
    assert.match(smoke, /"--heartbeat"/);
    assert.match(smoke, /session_id/);
    assert.match(smoke, /script_sha256/);
    assert.match(smoke, /release_version/);
    assert.match(smoke, /build_identity/);
    assert.match(smoke, /agent_root/);
    assert.match(smoke, /WaitForExit\(150000\)/);
    assert.match(smoke, /WaitForExit\(5000\)/);
    assert.match(smoke, /timed out and could not be killed/);
    assert.match(smoke, /did not exit within 5 seconds after Kill/);
    assert.doesNotMatch(smoke, /BootstrapAgent/);
    assert.doesNotMatch(smoke, /Get-ScheduledTask/);
    assert.doesNotMatch(smoke, /Start-Process/);
    assert.doesNotMatch(smoke, /run_export\.vbs/);
    assert.match(smoke, /WINDOWS_ILLUSTRATOR_JSX_SMOKE ok/);

    const blenderSmokePath = join(repoRoot, "scripts/windows/blender-contract-smoke.ps1");
    const blenderSmokeBytes = readFileSync(blenderSmokePath);
    assert.equal(blenderSmokeBytes[0], 0xef);
    assert.equal(blenderSmokeBytes[1], 0xbb);
    assert.equal(blenderSmokeBytes[2], 0xbf);
    const blenderSmoke = blenderSmokeBytes.toString("utf8").replace(/^\uFEFF/, "");
    assert.match(script, /blender-contract-smoke\.ps1/);
    assert.match(script, /Blender 合同冒烟失败/);
    const blenderSmokeIdx = script.indexOf("blender-contract-smoke.ps1");
    assert.ok(blenderSmokeIdx > illustratorSmokeIdx && commitIdx > blenderSmokeIdx);
    assert.match(blenderSmoke, /RUNNER_TEMP/);
    assert.match(blenderSmoke, /blender_contract_smoke\.py/);
    assert.match(blenderSmoke, /TimeoutMs = 90000/);
    assert.match(blenderSmoke, /Hangzhou-frozen 90s budget/);
    assert.match(blenderSmoke, /CREATE_SUSPENDED/);
    assert.match(blenderSmoke, /PROC_THREAD_ATTRIBUTE_JOB_LIST/);
    assert.match(blenderSmoke, /EXTENDED_STARTUPINFO_PRESENT/);
    assert.match(blenderSmoke, /StartSuspendedInJob/);
    assert.match(blenderSmoke, /StringBuilder/);
    assert.match(blenderSmoke, /ResumeThread/);
    assert.match(blenderSmoke, /WaitForSingleObject/);
    assert.match(blenderSmoke, /TerminateProcess/);
    assert.match(blenderSmoke, /RequireExitCode/);
    assert.match(blenderSmoke, /IsProcessInJob/);
    assert.match(blenderSmoke, /timed out and could not be killed/);
    assert.match(blenderSmoke, /WINDOWS_BLENDER_CONTRACT_SMOKE ok/);
    assert.match(blenderSmoke, /PYTHONUTF8/);
    assert.match(blenderSmoke, /CreateJobObject/);
    assert.match(blenderSmoke, /SetInformationJobObject/);
    assert.match(blenderSmoke, /failed to join Job Object/);
    assert.match(blenderSmoke, /TerminateJobObject/);
    assert.match(blenderSmoke, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
    assert.match(blenderSmoke, /BeianSmokeJob\]::CloseHandle\(\$job\)/);
    assert.doesNotMatch(blenderSmoke, /AssignProcessToJobObject/);
    assert.doesNotMatch(blenderSmoke, /STARTF_USESTDHANDLES/);
    assert.doesNotMatch(blenderSmoke, /GetStdHandle/);
    assert.doesNotMatch(blenderSmoke, /taskkill\.exe/);
    assert.doesNotMatch(blenderSmoke, /ProcessStartInfo/);
    assert.doesNotMatch(blenderSmoke, /ReadToEndAsync/);
    assert.doesNotMatch(blenderSmoke, /WaitForExit/);
    assert.doesNotMatch(blenderSmoke, /Environment\["RUNNER_TEMP"\]/);
    assert.match(script, /-Python \$releasePython/);
    assert.match(script, /-TimeoutMs 90000/);
    assert.doesNotMatch(script, /TimeoutMs 720000/);
    assert.match(script, /Blender 合同冒烟跳过：未解析到 BLENDER_EXECUTABLE/);
    assert.match(script, /BLENDER_EXECUTABLE/);
    assert.doesNotMatch(blenderSmoke, /compare_glb_artifact_contract/);
    assert.doesNotMatch(blenderSmoke, /generation\.json/);
    assert.doesNotMatch(blenderSmoke, /sealGeneration/);
    assert.doesNotMatch(blenderSmoke, /WB_DATA_DIR\\tasks/);
    assert.match(script, /Illustrator Session 1 冒烟失败/);
  });

  it("keeps drain and armed recovery when Blender contract smoke fails or times out", () => {
    const blenderSmoke = readFileSync(join(repoRoot, "scripts/windows/blender-contract-smoke.ps1"), "utf8").replace(/^\uFEFF/, "");
    const drainFenceIdx = indexOf(/Write-StartupDrainFence \$releaseLeaseId/);
    const illustratorIdx = script.indexOf("illustrator-jsx-smoke.ps1");
    const blenderIdx = script.indexOf("blender-contract-smoke.ps1");
    const blenderFailIdx = script.indexOf('throw "Blender 合同冒烟失败');
    const commitIdx = script.indexOf("Commit-ReleaseRecovery $mergedHeadSha $ver");
    const openDrainIdx = script.indexOf("Open-TargetReleaseDrain $targetDrain $ver");
    const recoverIdx = script.indexOf('Invoke-ArmedRecovery "升版失败"');
    assert.ok(drainFenceIdx >= 0 && illustratorIdx > drainFenceIdx);
    assert.ok(blenderIdx > illustratorIdx);
    assert.ok(blenderFailIdx > blenderIdx);
    assert.ok(commitIdx > blenderFailIdx);
    assert.ok(openDrainIdx > commitIdx);
    assert.ok(recoverIdx > blenderFailIdx);
    assert.match(script, /catch \{\s*Invoke-ArmedRecovery "升版失败"/);
    assert.match(blenderSmoke, /Blender contract smoke timed out \(Hangzhou-frozen 90s budget\)/);
    assert.match(blenderSmoke, /WaitForSingleObject/);
    assert.match(blenderSmoke, /CREATE_SUSPENDED/);
    assert.match(blenderSmoke, /PROC_THREAD_ATTRIBUTE_JOB_LIST/);
    assert.match(blenderSmoke, /TerminateProcess/);
    assert.doesNotMatch(blenderSmoke, /compare_glb_artifact_contract/);
    assert.doesNotMatch(blenderSmoke, /load_glb_artifact/);
    assert.doesNotMatch(blenderSmoke, /sealGeneration/);
    assert.match(script, /Illustrator Session 1 冒烟失败/);
    assert.match(script, /illustrator-jsx-smoke\.ps1/);
  });

  it("keeps VERSION, npm version, and the Hono health constant aligned", () => {
    const releaseVersion = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
    const packageVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
    const indexSource = readFileSync(join(repoRoot, "apps/web/server/src/index.ts"), "utf8");
    const match = /const VERSION = "([^"]+)"/.exec(indexSource);
    assert.ok(match, "missing Hono VERSION constant");
    assert.equal(match[1], releaseVersion);
    assert.equal(packageVersion, releaseVersion.split(".").slice(0, 3).join("."));
  });
});
