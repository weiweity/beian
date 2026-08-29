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
const dependencyCheckPath = join(repoRoot, "scripts/windows/release-dependency-check.mjs");
const dependencyCheck = readFileSync(dependencyCheckPath, "utf8");

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
    assert.match(script, /\$global:LASTEXITCODE = \$code/);
    assert.ok(indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/) < indexOf(/Invoke-Git merge --ff-only \$TargetSha/));
  });

  it("resets npm-dirty lockfile and refuses other tracked dirt before stopping 8787", () => {
    assert.match(script, /function Restore-NpmLockfileWorktree/);
    assert.ok(indexOf(/^Restore-NpmLockfileWorktree$/m) < indexOf(/工作树有未提交改动，拒绝停 8787/));
    assert.ok(indexOf(/^Restore-NpmLockfileWorktree$/m) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.match(script, /symbolic-ref --quiet --short HEAD/);
    assert.match(script, /当前分支不是 main，拒绝切分支或停 8787/);
    assert.doesNotMatch(script, /Invoke-Git\s+(?:checkout|reset)\b/);
    assert.ok(indexOf(/工作树有未提交改动，拒绝停 8787/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.ok(indexOf(/本地 main 比 origin\/main 多/) < indexOf(/Stop-Service beian-server-8787 so WinSW onfailure does not respawn/));
    assert.match(script, /status --porcelain --untracked-files=no/);
    assert.match(script, /origin\/main\.\.HEAD/);
  });

  it("binds the bootstrap, dependency checks, merge, and journal to one immutable target SHA", () => {
    const yml = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../../.github/workflows/hangzhou-release.yml"),
      "utf8",
    );
    assert.match(script, /\[string\]\$TargetSha = ""/);
    assert.match(script, /function Resolve-ReleaseTarget/);
    assert.match(script, /TargetSha 必须是完整的 40 位 Git commit SHA/);
    assert.match(script, /merge-base --is-ancestor \$resolved origin\/main/);
    assert.match(script, /merge-base --is-ancestor \$preSha \$TargetSha/);
    assert.match(script, /过期 workflow 不得回退或部署旁支/);
    assert.match(script, /Invoke-Git merge --ff-only \$TargetSha/);
    assert.match(script, /\$mergedHeadSha = \(git rev-parse HEAD\)/);
    assert.match(script, /\$mergedHeadSha -ne \$TargetSha/);
    assert.match(script, /merge 后 HEAD=.*不是停服前锁定的 TargetSha/);
    assert.doesNotMatch(script, /\$targetSha\b/);
    assert.match(script, /target_sha = \$RequestedTargetSha/);
    assert.match(script, /target_version = \$RequestedTargetVersion/);
    assert.match(script, /git_transaction_target_sha = \$TargetSha/);
    assert.match(recovery, /git_transaction_target_sha/);
    assert.match(recovery, /immutable target SHA/);
    assert.doesNotMatch(script, /Invoke-Git merge --ff-only origin\/main/);
    assert.doesNotMatch(script, /Assert-OfflineDependencyHandoff \$preSha "origin\/main"/);
    assert.match(yml, /\?ref=' \+ \[Uri\]::EscapeDataString\(\$env:GITHUB_SHA\)/);
    assert.match(yml, /'-TargetSha',\$env:GITHUB_SHA/);
    const mergeIdx = script.indexOf("Invoke-Git merge --ff-only $TargetSha");
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
    assert.match(script, /git_transaction_source_stage = "stopped"/);
    assert.match(script, /git_transaction_baseline = "all-absent"/);
    assert.match(script, /git_transaction_target_sha = \$TargetSha/);
    assert.match(script, /git_transaction_lock_policy_sha256/);
    assert.ok(indexOf(/Arm-GitMergeTransaction/) < indexOf(/Invoke-Git merge --ff-only \$TargetSha/));
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
    assert.match(recovery, /git -C \$root reset --hard \$preSha/);
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
    assert.ok(recovery.indexOf("git -C $root reset --hard $preSha") < recovery.indexOf("Assert-RecoveryRuntimeIntegrity $root $python"));
    assert.ok(recovery.indexOf("Restore-UiSnapshot $uiSnapshot") < recovery.indexOf("git -C $root reset --hard $preSha"));
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
    assert.match(script, /\^0\\\.19\\\.\\d\+\\\.\\d\+\$/);
    assert.match(script, /targetVersion -ne "0\.20\.0\.0"/);
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
    assert.ok(indexOf(/Stop-Service -Name \$name -Force/) < indexOf(/Invoke-Git merge --ff-only \$TargetSha/));
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
    assert.match(script, /Unregister-ScheduledTask/);
    assert.match(script, /restored tree has no Illustrator agent/);
    assert.ok(indexOf(/Set-ReleaseJournalStage "ui_build"/) < indexOf(/^  Sync-IllustratorAgentTaskToCurrentTree$/m));
    assert.ok(indexOf(/^  Sync-IllustratorAgentTaskToCurrentTree$/m) < indexOf(/start beian-server/));
    assert.match(recovery, /treeInstaller/);
    assert.match(recovery, /runtimeInstaller/);
    assert.match(recovery, /-Uninstall/);
    assert.match(recovery, /runtime Illustrator installer hash does not match/);
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
    assert.match(script, /function Invoke-Git/);
    assert.match(script, /function Get-GithubAuthHeader/);
    assert.match(script, /x-access-token:/);
    assert.match(script, /ToBase64String/);
    assert.match(script, /http.extraheader=\$AuthHeader/);
    assert.doesNotMatch(script, /http.extraheader=AUTHORIZATION: bearer/);
    assert.match(script, /function Invoke-GitFetch/);
    assert.match(script, /Invoke-GitFetch -LogPath \$log/);
    assert.match(script, /Invoke-Git merge --ff-only \$TargetSha/);
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
