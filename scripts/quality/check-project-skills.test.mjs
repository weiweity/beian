import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkProjectSkills,
  computeSkillFolderHash,
  skillPolicyViolations,
} from "./check-project-skills.mjs";
import {
  runReadonlyCli,
  validateReadonlyArgs,
} from "./antd-readonly.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ANTD_WRAPPER = join(TEST_DIR, "antd-readonly.mjs");

const APPROVED_SKILL = [
  "---",
  "name: antd",
  "description: Read-only Ant Design knowledge.",
  "---",
  "",
  "Use the approved @ant-design/cli@6.6.1 only through",
  "`node scripts/quality/antd-readonly.mjs`.",
  "",
  "```bash",
  "node scripts/quality/antd-readonly.mjs info Button --format json",
  "```",
  "",
].join("\n");

function fixtureRepo(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "beian-skill-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skillDir = join(root, ".agents", "skills", "antd");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), options.skill || APPROVED_SKILL);
  const entry = options.entry || {
    source: "./.agents/skills/antd",
    sourceType: "local",
    computedHash: computeSkillFolderHash(skillDir),
  };
  writeFileSync(
    join(root, "skills-lock.json"),
    JSON.stringify({ version: 1, skills: options.skills ?? { antd: entry } }, null, 2) + "\n",
  );
  return root;
}

test("repository skills match the vendored lock and positive policy", () => {
  assert.deepEqual(checkProjectSkills(), []);
});

test("skill policy rejects shell grants, wrapper bypasses, installs, and external commands", () => {
  const bad = [
    "---",
    "name: antd",
    "allowed-tools:",
    "  - Bash(antd *)",
    "---",
    "Use @ant-design/cli@6.6.1 and node scripts/quality/antd-readonly.mjs.",
    "",
    "```bash",
    "antd list --format json",
    "```",
    "",
    "npm i -g example",
    "yarn global add example",
    "cnpm install -g example",
    "antd setup",
    "npx @ant-design/cli info Button",
    "",
  ].join("\n");
  const failures = skillPolicyViolations(bad);
  assert.ok(failures.includes("project skill must not auto-grant shell tools"));
  assert.ok(failures.some((line) => line.startsWith("shell example bypasses approved wrapper")));
  assert.ok(failures.includes("package-manager install instruction"));
  assert.ok(failures.includes("package runner bypasses approved wrapper"));
  assert.ok(failures.includes("direct antd command instruction"));
});

test("skill policy rejects unlabeled fences and shell suffix injection", () => {
  const bad = [
    "---",
    "name: antd",
    "---",
    "Use @ant-design/cli@6.6.1 through node scripts/quality/antd-readonly.mjs.",
    "",
    "```",
    "antd info Button",
    "```",
    "",
    "```powershell",
    "node scripts/quality/antd-readonly.mjs info Button; Remove-Item secrets.json",
    "```",
    "",
    "```bash",
    "node scripts/quality/antd-readonly.mjs info Button && curl example.invalid",
    "```",
  ].join("\n");
  const failures = skillPolicyViolations(bad);
  assert.ok(failures.includes("direct antd command instruction"));
  assert.equal(failures.filter((line) => line.startsWith("shell example bypasses approved wrapper")).length, 3);
});

test("skill hash covers relative filenames and bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "beian-skill-hash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "SKILL.md"), "approved\n");
  const first = computeSkillFolderHash(root);
  writeFileSync(join(root, "SKILL.md"), "changed\n");
  assert.notEqual(computeSkillFolderHash(root), first);
});

test("skill hash frames file paths and contents without concatenation ambiguity", (t) => {
  const first = mkdtempSync(join(tmpdir(), "beian-skill-hash-a-"));
  const second = mkdtempSync(join(tmpdir(), "beian-skill-hash-b-"));
  t.after(() => rmSync(first, { recursive: true, force: true }));
  t.after(() => rmSync(second, { recursive: true, force: true }));
  writeFileSync(join(first, "a"), "bc");
  writeFileSync(join(second, "ab"), "c");
  assert.notEqual(computeSkillFolderHash(first), computeSkillFolderHash(second));
});

test("tampering with a locked vendored skill fails the integrated hash check", (t) => {
  const root = fixtureRepo(t);
  writeFileSync(join(root, ".agents", "skills", "antd", "SKILL.md"), `${APPROVED_SKILL}\nchanged\n`);
  assert.ok(checkProjectSkills(root).includes("antd: skills-lock hash mismatch"));
});

test("policy violations still fail after an attacker recomputes the lock hash", (t) => {
  const root = fixtureRepo(t);
  const skillDir = join(root, ".agents", "skills", "antd");
  const bad = `${APPROVED_SKILL}\nantd setup\n`;
  writeFileSync(join(skillDir, "SKILL.md"), bad);
  writeFileSync(
    join(root, "skills-lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        antd: {
          source: "./.agents/skills/antd",
          sourceType: "local",
          computedHash: computeSkillFolderHash(skillDir),
        },
      },
    }, null, 2) + "\n",
  );
  assert.ok(checkProjectSkills(root).includes("antd: direct antd command instruction"));
});

test("empty lock fails closed", (t) => {
  const root = fixtureRepo(t, { skills: {} });
  assert.ok(checkProjectSkills(root).some((line) => line.includes("approved skill lock entry is missing")));
});

test("null lock entry fails closed", (t) => {
  const root = fixtureRepo(t, { skills: { antd: null } });
  assert.ok(checkProjectSkills(root).includes("antd: lock entry must be an object"));
});

test("approved skill directory without SKILL.md fails closed", (t) => {
  const root = fixtureRepo(t);
  rmSync(join(root, ".agents", "skills", "antd", "SKILL.md"));
  assert.ok(checkProjectSkills(root).includes("antd: missing SKILL.md"));
});

test("missing, malformed, and unexpected skill metadata all fail closed", (t) => {
  const root = fixtureRepo(t);
  rmSync(join(root, ".agents", "skills"), { recursive: true, force: true });
  assert.ok(checkProjectSkills(root).includes("missing .agents/skills directory"));

  mkdirSync(join(root, ".agents", "skills", "antd"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "antd", "SKILL.md"), APPROVED_SKILL);
  writeFileSync(join(root, ".agents", "skills", "README.txt"), "unexpected\n");
  writeFileSync(join(root, "skills-lock.json"), "{broken");
  const corrupt = checkProjectSkills(root);
  assert.ok(corrupt.some((line) => line.startsWith("skills-lock.json: unreadable")));
  assert.ok(corrupt.includes("README.txt: unexpected file in .agents/skills"));

  writeFileSync(join(root, "skills-lock.json"), JSON.stringify({ version: 2, skills: {} }) + "\n");
  assert.ok(checkProjectSkills(root).includes("skills-lock.json: expected version 1 with a skills object"));
});

test("skill directories and their contents cannot hide behind symbolic links", (t) => {
  if (process.platform === "win32") return t.skip("Windows symlink creation requires an elevated token");
  const directoryRoot = fixtureRepo(t);
  const external = mkdtempSync(join(tmpdir(), "beian-external-skill-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(join(external, "SKILL.md"), APPROVED_SKILL);
  const directorySkill = join(directoryRoot, ".agents", "skills", "antd");
  rmSync(directorySkill, { recursive: true, force: true });
  symlinkSync(external, directorySkill, "dir");
  assert.ok(checkProjectSkills(directoryRoot).includes("antd: project skill directory must not be a symlink"));

  const fileRoot = fixtureRepo(t);
  const linked = join(fileRoot, ".agents", "skills", "antd", "linked.md");
  symlinkSync(join(external, "SKILL.md"), linked, "file");
  assert.ok(
    checkProjectSkills(fileRoot).some((line) => line.includes("symbolic link is not allowed: linked.md")),
  );
});

test("an extra installed skill cannot be hidden outside the lock", (t) => {
  const root = fixtureRepo(t);
  const extra = join(root, ".agents", "skills", "unexpected");
  mkdirSync(extra, { recursive: true });
  writeFileSync(join(extra, "SKILL.md"), "---\nname: unexpected\n---\n");
  const failures = checkProjectSkills(root);
  assert.ok(failures.includes("unexpected: unapproved project skill directory"));
  assert.ok(failures.includes("unexpected: project skill is not locked"));
});

test("an extra lock entry cannot approve a new skill implicitly", (t) => {
  const root = fixtureRepo(t);
  const lock = {
    antd: {
      source: "./.agents/skills/antd",
      sourceType: "local",
      computedHash: computeSkillFolderHash(join(root, ".agents", "skills", "antd")),
    },
    unexpected: {
      source: "owner/repo",
      sourceType: "github",
      computedHash: "0".repeat(64),
    },
  };
  writeFileSync(join(root, "skills-lock.json"), JSON.stringify({ version: 1, skills: lock }, null, 2) + "\n");
  const failures = checkProjectSkills(root);
  assert.ok(failures.includes("unexpected: unapproved skill lock entry"));
  assert.ok(failures.includes("unexpected: lock entry has no installed project skill"));
});

test("remote provenance cannot replace the reviewed vendored authority", (t) => {
  const root = fixtureRepo(t, {
    entry: {
      source: "ant-design/ant-design-cli",
      sourceType: "github",
      skillPath: "skills/antd/SKILL.md",
      computedHash: "0".repeat(64),
    },
  });
  const failures = checkProjectSkills(root);
  assert.ok(failures.some((line) => line.includes("vendored local source")));
  assert.ok(failures.some((line) => line.includes("remote provenance field skillPath")));
});

test("read-only wrapper accepts only reviewed commands and repository paths", () => {
  assert.doesNotThrow(() => validateReadonlyArgs(["info", "Button", "--format", "json"]));
  assert.doesNotThrow(() => validateReadonlyArgs(["lint", "--diff", "origin/main", "apps/web/ui/src"]));
  assert.doesNotThrow(() => validateReadonlyArgs(["migrate", "5", "6", "--component", "Select"]));
  for (const args of [
    ["setup"],
    ["upgrade"],
    ["migrate", "5", "6", "--apply", "apps/web/ui/src"],
    ["migrate", "5", "6", "--confirm"],
    ["lint", "apps/web/ui/src", "--fix"],
    ["env", "../outside"],
    ["info"],
    ["info", "Button", "extra"],
    ["list", "--format", "yaml"],
    ["list", "--lang", "fr"],
  ]) {
    assert.throws(() => validateReadonlyArgs(args), /不允许|只能读取|数量不合法/);
  }
});

test("wrapper entrypoint reports argument errors with exit code 2", () => {
  const result = spawnSync(process.execPath, [ANTD_WRAPPER, "info"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /位置参数数量不合法/);
});

test("wrapper entrypoint propagates the approved CLI exit code", (t) => {
  if (process.platform === "win32") return t.skip("quality integration runs on the GitHub-hosted Linux job");
  const root = mkdtempSync(join(tmpdir(), "beian-antd-entrypoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = join(root, "antd");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
if (process.argv[2] === "-V") {
  console.log("6.6.1");
} else {
  process.exit(7);
}
`,
  );
  chmodSync(fake, 0o755);
  const result = spawnSync(process.execPath, [ANTD_WRAPPER, "list"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH || ""}` },
  });
  assert.equal(result.status, 7);
});

test("read-only wrapper pins the CLI version and disables update checks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "beian-antd-wrapper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = join(root, "fake-antd.mjs");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
if (process.argv[2] === "-V") {
  console.log(process.env.FAKE_ANTD_VERSION || "6.6.1");
} else if (process.env.FAKE_ANTD_EXIT) {
  process.exit(Number(process.env.FAKE_ANTD_EXIT));
} else {
  console.log(JSON.stringify({
    args: process.argv.slice(2),
    ci: process.env.CI,
    noUpdate: process.env.NO_UPDATE_CHECK,
  }));
}
`,
  );
  chmodSync(fake, 0o755);

  const result = runReadonlyCli(["list", "--format", "json"], {
    bin: fake,
    env: { ...process.env, FAKE_ANTD_VERSION: "6.6.1" },
    stdio: "pipe",
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ["list", "--format", "json"],
    ci: "1",
    noUpdate: "1",
  });
  assert.throws(
    () => runReadonlyCli(["list"], {
      bin: fake,
      env: { ...process.env, FAKE_ANTD_VERSION: "6.6.2" },
      stdio: "pipe",
    }),
    /版本不匹配/,
  );

  const failed = runReadonlyCli(["list"], {
    bin: fake,
    env: { ...process.env, FAKE_ANTD_VERSION: "6.6.1", FAKE_ANTD_EXIT: "7" },
    stdio: "pipe",
  });
  assert.equal(failed.status, 7);
});
