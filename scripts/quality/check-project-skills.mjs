import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");

const APPROVED_SKILLS = Object.freeze({
  antd: {
    source: "./.agents/skills/antd",
    sourceType: "local",
    wrapper: "node scripts/quality/antd-readonly.mjs",
    versionMarker: "@ant-design/cli@6.6.1",
  },
});

function collectFiles(baseDir, currentDir, files) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(currentDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${relative(baseDir, path)}`);
    if (entry.isDirectory()) collectFiles(baseDir, path, files);
    else if (entry.isFile()) {
      files.push({
        relativePath: relative(baseDir, path).split(sep).join("/"),
        content: readFileSync(path),
      });
    }
  }
}

export function computeSkillFolderHash(skillDir) {
  const files = [];
  collectFiles(skillDir, skillDir, files);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const hash = createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    const pathLength = Buffer.allocUnsafe(4);
    const contentLength = Buffer.allocUnsafe(8);
    pathLength.writeUInt32BE(pathBytes.length);
    contentLength.writeBigUInt64BE(BigInt(file.content.length));
    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(contentLength);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

function executableBlocks(content) {
  return [...content.matchAll(/```([^\n`]*)\n([\s\S]*?)```/gu)]
    .filter((match) => /^(?:|bash|sh|shell|zsh|powershell|pwsh|cmd|bat|console|terminal)\s*$/iu.test(match[1]))
    .map((match) => match[2]);
}

export function skillPolicyViolations(content, policy = APPROVED_SKILLS.antd) {
  const violations = [];
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/u);
  if (!frontmatterMatch) return ["missing YAML frontmatter"];
  const frontmatter = frontmatterMatch[1];
  const body = content.slice(frontmatterMatch[0].length);

  if (/^allowed-tools\s*:/mu.test(frontmatter)) {
    violations.push("project skill must not auto-grant shell tools");
  }
  if (!body.includes(policy.wrapper)) violations.push("approved read-only wrapper is not documented");
  if (!body.includes(policy.versionMarker)) violations.push("approved CLI version is not documented");

  const safeExample = new RegExp(
    `^${policy.wrapper.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?: [A-Za-z0-9@._/:=-]+)*$`,
    "u",
  );
  for (const block of executableBlocks(body)) {
    for (const rawLine of block.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (!safeExample.test(line)) {
        violations.push(`shell example bypasses approved wrapper: ${line.slice(0, 80)}`);
      }
    }
  }

  const normalized = body.replace(/[`*_]/gu, " ").replace(/\s+/gu, " ");
  if (/\b(?:npm|pnpm|yarn|bun|cnpm)\s+(?:i|install|add|global|update|upgrade)\b/iu.test(normalized)) {
    violations.push("package-manager install instruction");
  }
  if (/\b(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec)\b[^\n]*(?:@ant-design\/cli\b|\bantd\b)/iu.test(normalized)) {
    violations.push("package runner bypasses approved wrapper");
  }
  if (/\bantd\s+(?:list|info|doc|demo|token|design\.md|semantic|changelog|doctor|usage|lint|migrate|env|upgrade|setup|bug|bug-cli|mcp)\b/iu.test(normalized)) {
    violations.push("direct antd command instruction");
  }
  return [...new Set(violations)];
}

function projectSkillNames(root, failures) {
  const skillsRoot = join(root, ".agents", "skills");
  if (!existsSync(skillsRoot)) {
    failures.push("missing .agents/skills directory");
    return [];
  }
  const names = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      failures.push(`${entry.name}: project skill directory must not be a symlink`);
    } else if (entry.isDirectory()) {
      names.push(entry.name);
    } else {
      failures.push(`${entry.name}: unexpected file in .agents/skills`);
    }
  }
  return names.sort();
}

function readLock(root, failures) {
  const path = join(root, "skills-lock.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== 1 || !parsed.skills || typeof parsed.skills !== "object" || Array.isArray(parsed.skills)) {
      failures.push("skills-lock.json: expected version 1 with a skills object");
      return {};
    }
    return parsed.skills;
  } catch (error) {
    failures.push(`skills-lock.json: unreadable (${error instanceof Error ? error.message : String(error)})`);
    return {};
  }
}

export function checkProjectSkills(repoRoot = REPO_ROOT) {
  const failures = [];
  const lockSkills = readLock(repoRoot, failures);
  const actualNames = projectSkillNames(repoRoot, failures);
  const approvedNames = Object.keys(APPROVED_SKILLS).sort();
  const lockNames = Object.keys(lockSkills).sort();

  for (const name of approvedNames) {
    if (!actualNames.includes(name)) failures.push(`${name}: approved skill directory is missing`);
    if (!lockNames.includes(name)) failures.push(`${name}: approved skill lock entry is missing`);
  }
  for (const name of actualNames) {
    if (!approvedNames.includes(name)) failures.push(`${name}: unapproved project skill directory`);
    if (!lockNames.includes(name)) failures.push(`${name}: project skill is not locked`);
  }
  for (const name of lockNames) {
    if (!approvedNames.includes(name)) failures.push(`${name}: unapproved skill lock entry`);
    if (!actualNames.includes(name)) failures.push(`${name}: lock entry has no installed project skill`);
  }

  for (const name of approvedNames) {
    const policy = APPROVED_SKILLS[name];
    const entry = lockSkills[name];
    const skillDir = join(repoRoot, ".agents", "skills", name);
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath)) {
      failures.push(`${name}: missing SKILL.md`);
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      failures.push(`${name}: lock entry must be an object`);
      continue;
    }
    if (entry.sourceType !== policy.sourceType || entry.source !== policy.source) {
      failures.push(`${name}: lock must use vendored local source ${policy.source}`);
    }
    for (const remoteField of ["sourceUrl", "ref", "skillPath", "pluginName"]) {
      if (entry[remoteField] !== undefined) failures.push(`${name}: lock contains remote provenance field ${remoteField}`);
    }
    if (typeof entry.computedHash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.computedHash)) {
      failures.push(`${name}: lock computedHash must be a lowercase SHA-256`);
    }
    try {
      if (computeSkillFolderHash(skillDir) !== entry.computedHash) {
        failures.push(`${name}: skills-lock hash mismatch`);
      }
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const violation of skillPolicyViolations(readFileSync(skillPath, "utf8"), policy)) {
      failures.push(`${name}: ${violation}`);
    }
  }
  return [...new Set(failures)];
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const failures = checkProjectSkills();
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("project skill policy ok");
  }
}
