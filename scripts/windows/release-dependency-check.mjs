import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const MANIFEST_PATHS = [
  "package.json",
  "apps/web/ui/package.json",
  "apps/web/server/package.json",
];
const DEPENDENCY_KEYS = [
  "workspaces",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "overrides",
  "engines",
  "os",
  "cpu",
  "packageManager",
];

function assertRevision(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) || value.includes("..")) {
    throw new Error("revision is invalid");
  }
  return value;
}

function readRevisionJson(root, revision, path) {
  const text = execFileSync(
    "git",
    ["-C", root, "show", `${revision}:${path}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(text);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function dependencyProjection(manifest) {
  return Object.fromEntries(
    DEPENDENCY_KEYS.filter((key) => Object.hasOwn(manifest, key)).map((key) => [key, manifest[key]]),
  );
}

function dependencyFingerprint(rootInput, revisionInput) {
  const root = resolve(rootInput);
  const revision = assertRevision(revisionInput);
  const lock = readRevisionJson(root, revision, "package-lock.json");

  // A release version bump updates only the root package versions. They are not
  // dependency graph changes; every package entry and manifest dependency field
  // remains part of the canonical hash. Node's JSON parser intentionally handles
  // npm lockfiles' required empty-string packages[""] key on Windows PS5.1 hosts.
  delete lock.version;
  if (lock.packages?.[""] && typeof lock.packages[""] === "object") {
    delete lock.packages[""].version;
  }

  const manifests = Object.fromEntries(
    MANIFEST_PATHS.map((path) => [
      path,
      dependencyProjection(readRevisionJson(root, revision, path)),
    ]),
  );
  return createHash("sha256")
    .update(JSON.stringify(stableValue({ lock, manifests })), "utf8")
    .digest("hex");
}

function main(argv) {
  const [command, root, revision] = argv;
  if (command !== "fingerprint" || !root || !revision || argv.length !== 3) {
    throw new Error("usage: release-dependency-check.mjs fingerprint <repo-root> <revision>");
  }
  process.stdout.write(`${dependencyFingerprint(root, revision)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`release dependency check failed: ${message.slice(0, 300)}\n`);
  process.exitCode = 1;
}
