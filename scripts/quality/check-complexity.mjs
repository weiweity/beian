#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
export const BASELINE_RELATIVE_PATH = "config/quality/dead-code-baseline.json";
export const BASELINE_PATH = resolve(REPO_ROOT, BASELINE_RELATIVE_PATH);
export const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const QUALITY_TOOLS_ROOT = resolve(REPO_ROOT, "tools/quality");
const HELP_TEXT = `beian complexity quality gate

Usage:
  npm run quality [-- --base-ref <git-ref>] [-- --json]
  npm run quality:deep

Options:
  --base-ref <git-ref>  Override the automatically discovered target branch
  --report-only         Print findings without enforcing the baseline
  --deep                Production/low-confidence report-only scan
  --json                Emit JSON
  -h, --help            Show this help

Install:
  npm ci --prefix tools/quality
  apps/web/backend/.venv/bin/python -m pip install -r apps/web/backend/requirements-quality.txt`;

export class QualityToolError extends Error {
  constructor(code, message, fix = "") {
    super(message);
    this.name = "QualityToolError";
    this.code = code;
    this.fix = fix;
  }
}

function normalizeRepoPath(value, root = REPO_ROOT) {
  const absolute = isAbsolute(value) ? value : resolve(root, value);
  const repoRelative = relative(root, absolute).replaceAll("\\", "/");
  if (!repoRelative || repoRelative === "." || repoRelative.startsWith("../")) {
    throw new QualityToolError(
      "INVALID_FINDING_PATH",
      `扫描器返回了仓库外路径：${value}`,
      "修正扫描器入口或路径归一化规则。",
    );
  }
  return repoRelative;
}

export function normalizeFinding(finding, root = REPO_ROOT) {
  if (!finding || typeof finding !== "object") {
    throw new QualityToolError("INVALID_FINDING", "发现项不是对象。", "检查扫描器输出格式。");
  }
  const tool = String(finding.tool || "").trim();
  const kind = String(finding.kind || "").trim();
  const path = normalizeRepoPath(String(finding.path || ""), root);
  const symbol = String(finding.symbol || "").trim();
  const line = Number.isFinite(Number(finding.line)) ? Math.max(0, Number(finding.line)) : 0;
  const confidence = Number.isFinite(Number(finding.confidence))
    ? Math.max(0, Math.min(100, Number(finding.confidence)))
    : 100;
  if (!tool || !kind) {
    throw new QualityToolError("INVALID_FINDING", "发现项缺少 tool 或 kind。", "检查扫描器适配器。");
  }
  return { tool, kind, path, symbol, line, confidence };
}

export function findingKey(finding) {
  const normalized = normalizeFinding(finding);
  return JSON.stringify([normalized.tool, normalized.kind, normalized.path, normalized.symbol]);
}

function findingRecordKey(finding) {
  const normalized = normalizeFinding(finding);
  return JSON.stringify([
    normalized.tool,
    normalized.kind,
    normalized.path,
    normalized.symbol,
    normalized.line,
    normalized.confidence,
  ]);
}

function compareStableKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortFindings(findings) {
  return findings.map((candidate) => normalizeFinding(candidate)).sort((left, right) => {
    const stableOrder = compareStableKeys(findingKey(left), findingKey(right));
    if (stableOrder !== 0) return stableOrder;
    if (left.line !== right.line) return left.line - right.line;
    return left.confidence - right.confidence;
  });
}

export function normalizeKnipReport(report, root = REPO_ROOT) {
  if (!report || typeof report !== "object" || !Array.isArray(report.issues)) {
    throw new QualityToolError(
      "MALFORMED_KNIP_OUTPUT",
      "Knip JSON 缺少 issues 数组。",
      "确认 knip 版本和 --reporter json 输出合同。",
    );
  }
  const findings = [];
  for (const issue of report.issues) {
    if (!issue || typeof issue !== "object") {
      throw new QualityToolError("MALFORMED_KNIP_OUTPUT", "Knip issues 中出现非对象。", "检查 Knip 输出。");
    }
    for (const [category, values] of Object.entries(issue)) {
      if (["file", "owners"].includes(category) || !Array.isArray(values)) continue;
      const items = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
      for (const item of items) {
        if (!item || typeof item !== "object" || typeof item.name !== "string") {
          throw new QualityToolError(
            "MALFORMED_KNIP_OUTPUT",
            `Knip ${category} 项缺少 name。`,
            "检查 Knip JSON reporter 是否发生不兼容变更。",
          );
        }
        const isFile = category === "files";
        const findingPath = isFile ? item.name : issue.file;
        if (typeof findingPath !== "string" || !findingPath) {
          throw new QualityToolError(
            "MALFORMED_KNIP_OUTPUT",
            `Knip ${category} 项缺少文件路径。`,
            "检查 Knip JSON reporter 是否发生不兼容变更。",
          );
        }
        findings.push(
          normalizeFinding(
            {
              tool: "knip",
              kind: isFile ? "file" : category,
              path: findingPath,
              symbol: isFile ? "" : item.name,
              line: item.line || 0,
              confidence: 100,
            },
            root,
          ),
        );
      }
    }
  }
  return sortFindings(findings);
}

export function parseVultureOutput(output, root = REPO_ROOT) {
  const findings = [];
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = /^(.+?):(\d+): (.+) \((\d+)% confidence(?:, \d+ lines?)?\)$/.exec(line);
    if (!match) {
      throw new QualityToolError(
        "MALFORMED_VULTURE_OUTPUT",
        `无法解析 Vulture 输出：${line}`,
        "确认 vulture 精确版本及默认文本输出合同。",
      );
    }
    const message = match[3];
    const unused = /^unused (.+?) '(.+)'$/.exec(message);
    const isReachabilityFinding =
      /^unreachable code after '[^']+'$/.test(message) ||
      /^unsatisfiable '(?:if|ternary|while)' condition$/.test(message) ||
      /^unreachable 'else' (?:block|expression)$/.test(message) ||
      message === "redundant if-condition";
    if (!unused && !isReachabilityFinding) {
      throw new QualityToolError(
        "MALFORMED_VULTURE_OUTPUT",
        `无法识别 Vulture 诊断：${message}`,
        "核对 Vulture 2.16 的消息合同后再更新适配器。",
      );
    }
    findings.push(
      normalizeFinding(
        {
          tool: "vulture",
          kind: unused ? unused[1].replaceAll(" ", "_") : "unreachable_code",
          path: match[1],
          symbol: unused ? unused[2] : message,
          line: Number(match[2]),
          confidence: Number(match[4]),
        },
        root,
      ),
    );
  }
  return sortFindings(findings);
}

export function compareFindings(actual, baseline) {
  const actualSorted = sortFindings(actual);
  const baselineSorted = sortFindings(baseline);
  const actualCounts = findingCounts(actualSorted);
  const baselineCounts = findingCounts(baselineSorted);
  return {
    newFindings: findingsBeyondCount(actualSorted, baselineCounts),
    staleFindings: findingsBeyondCount(baselineSorted, actualCounts),
  };
}

export function baselineGrowth(currentBaseline, baseBaseline) {
  const baseCounts = findingCounts(sortFindings(baseBaseline));
  return findingsBeyondCount(sortFindings(currentBaseline), baseCounts);
}

function findingCounts(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function findingsBeyondCount(findings, allowedCounts) {
  const seen = new Map();
  return findings.filter((finding) => {
    const key = findingKey(finding);
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return count > (allowedCounts.get(key) || 0);
  });
}

export function runTool(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowedStatuses = options.allowedStatuses ?? [0];
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, CI: "1", ...(options.env || {}) },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new QualityToolError(
        "TOOL_TIMEOUT",
        `${command} 超过 ${timeoutMs}ms 未完成。`,
        "检查入口范围、缓存或卡住的子进程。",
      );
    }
    if (result.error.code === "ENOENT") {
      throw new QualityToolError(
        "TOOL_MISSING",
        `找不到质量工具：${command}`,
        "先执行 npm ci，并安装 apps/web/backend/requirements-quality.txt。",
      );
    }
    throw new QualityToolError("TOOL_FAILED", `${command} 启动失败：${result.error.message}`, "检查本机运行环境。");
  }
  if (!allowedStatuses.includes(result.status)) {
    const detail = String(result.stderr || result.stdout || "").trim().slice(0, 2_000);
    throw new QualityToolError(
      "TOOL_FAILED",
      `${command} 退出码 ${result.status}${detail ? `：${detail}` : ""}`,
      "按工具输出修正配置或依赖；不要跳过扫描。",
    );
  }
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), status: result.status };
}

function validateBaseRef(value, source) {
  const ref = String(value || "").trim();
  if (
    !ref ||
    !/^[A-Za-z0-9][A-Za-z0-9._/@+/-]*$/.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.endsWith("/")
  ) {
    throw new QualityToolError(
      "INVALID_BASE_REF",
      `${source} 不是安全的 git ref：${value}`,
      "传入分支名或完整提交 SHA，不要传入 revision 表达式。",
    );
  }
  return ref;
}

export function resolveBaseRef(
  explicitBaseRef = "",
  {
    env = process.env,
    runGit = (args, options = {}) => runTool("git", args, options),
  } = {},
) {
  if (explicitBaseRef) return validateBaseRef(explicitBaseRef, "--base-ref");
  if (env.QUALITY_BASE_REF) return validateBaseRef(env.QUALITY_BASE_REF, "QUALITY_BASE_REF");

  const candidates = [];
  if (env.GITHUB_BASE_REF) {
    const githubBase = validateBaseRef(env.GITHUB_BASE_REF, "GITHUB_BASE_REF");
    candidates.push(`origin/${githubBase}`, githubBase);
  }

  const originHead = runGit(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { allowedStatuses: [0, 1, 128] },
  );
  if (originHead.status === 0 && originHead.stdout.trim()) {
    candidates.push(validateBaseRef(originHead.stdout, "origin/HEAD"));
  }
  candidates.push("origin/main", "main");

  for (const candidate of new Set(candidates)) {
    const exists = runGit(
      ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
      { allowedStatuses: [0, 1, 128] },
    );
    if (exists.status === 0) return candidate;
  }

  throw new QualityToolError(
    "BASE_REF_MISSING",
    "无法自动找到目标分支基线。",
    "先 fetch 目标分支，或运行 npm run quality -- --base-ref <git-ref>。",
  );
}

function parseJson(text, code, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new QualityToolError(code, `${label} 不是有效 JSON：${error.message}`, "检查文件或扫描器输出。");
  }
}

function pythonPath() {
  if (process.env.QUALITY_PYTHON) return process.env.QUALITY_PYTHON;
  return resolve(
    REPO_ROOT,
    process.platform === "win32"
      ? "apps/web/backend/.venv/Scripts/python.exe"
      : "apps/web/backend/.venv/bin/python",
  );
}

function knipPath() {
  return resolve(
    QUALITY_TOOLS_ROOT,
    process.platform === "win32" ? "node_modules/.bin/knip.cmd" : "node_modules/.bin/knip",
  );
}

function normalizedVersion(output) {
  const match = String(output).match(/\d+\.\d+(?:\.\d+)?/);
  if (!match) {
    throw new QualityToolError("MALFORMED_TOOL_VERSION", `无法识别工具版本：${output}`, "检查工具版本输出。");
  }
  return match[0];
}

export function scanFindings({ minConfidence = 80, knipProduction = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const knip = knipPath();
  const python = pythonPath();
  if (!existsSync(knip)) {
    throw new QualityToolError(
      "TOOL_MISSING",
      `找不到 Knip：${knip}`,
      "执行 npm ci --prefix tools/quality；质量依赖不得进入生产依赖图。",
    );
  }
  if (!existsSync(python)) {
    throw new QualityToolError(
      "TOOL_MISSING",
      `找不到质量 Python：${python}`,
      "创建 apps/web/backend/.venv，并安装生产与质量 requirements。",
    );
  }

  const knipVersion = normalizedVersion(runTool(knip, ["--version"], { timeoutMs }).stdout);
  const vultureVersionResult = runTool(python, ["-m", "vulture", "--version"], { timeoutMs });
  const vultureVersion = normalizedVersion(`${vultureVersionResult.stdout}\n${vultureVersionResult.stderr}`);

  const knipArgs = ["--config", "knip.json"];
  if (knipProduction) knipArgs.push("--production");
  knipArgs.push("--reporter", "json", "--no-progress", "--no-config-hints");
  const knipResult = runTool(knip, knipArgs, { timeoutMs, allowedStatuses: [0, 1] });
  const knipFindings = normalizeKnipReport(
    parseJson(knipResult.stdout, "MALFORMED_KNIP_OUTPUT", "Knip 输出"),
  );

  const vultureResult = runTool(
    python,
    [
      "-m",
      "vulture",
      "apps/web/backend/app",
      "apps/web/backend/scripts",
      "workers/packaging",
      "--min-confidence",
      String(minConfidence),
    ],
    { timeoutMs, allowedStatuses: [0, 3] },
  );
  const vultureFindings = parseVultureOutput(vultureResult.stdout);
  return {
    tools: { knip: knipVersion, vulture: vultureVersion },
    findings: sortFindings([...knipFindings, ...vultureFindings]),
    counts: { knip: knipFindings.length, vulture: vultureFindings.length },
  };
}

export function parseBaseline(text, label = BASELINE_RELATIVE_PATH) {
  const baseline = parseJson(text, "MALFORMED_BASELINE", label);
  if (
    !baseline ||
    baseline.schema_version !== 1 ||
    !baseline.tools ||
    typeof baseline.tools.knip !== "string" ||
    typeof baseline.tools.vulture !== "string" ||
    !baseline.policy ||
    baseline.policy.vulture_min_confidence !== 80 ||
    baseline.policy.knip_mode !== "repository" ||
    !Array.isArray(baseline.findings)
  ) {
    throw new QualityToolError(
      "MALFORMED_BASELINE",
      `${label} 不符合 schema_version=1 合同。`,
      "人工修正基线；扫描器不会自动重写。",
    );
  }
  const normalizedFindings = baseline.findings.map((finding) => normalizeFinding(finding));
  const recordKeys = normalizedFindings.map(findingRecordKey);
  if (new Set(recordKeys).size !== recordKeys.length) {
    throw new QualityToolError(
      "MALFORMED_BASELINE",
      `${label} 存在完全重复的 finding。`,
      "人工删除同一行的重复项；同文件同名但不同行的诊断必须保留。",
    );
  }
  const findings = sortFindings(normalizedFindings);
  const originalOrder = recordKeys;
  const canonicalOrder = findings.map(findingRecordKey);
  if (originalOrder.some((key, index) => key !== canonicalOrder[index])) {
    throw new QualityToolError(
      "MALFORMED_BASELINE",
      `${label} 未按稳定 finding identity 排序。`,
      "人工按 tool、kind、path、symbol 排序，避免基线产生无意义 diff。",
    );
  }
  return { ...baseline, findings };
}

function readCurrentBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    throw new QualityToolError(
      "BASELINE_MISSING",
      `缺少 ${BASELINE_RELATIVE_PATH}。`,
      "先配置扫描器，再人工生成并复核初始基线。",
    );
  }
  return parseBaseline(readFileSync(BASELINE_PATH, "utf8"));
}

export function readBaseBaseline(
  baseRef,
  { runGit = (args, options = {}) => runTool("git", args, options) } = {},
) {
  runGit(["cat-file", "-e", `${baseRef}^{commit}`]);
  const tree = runGit(["ls-tree", "-z", "--name-only", baseRef, "--", BASELINE_RELATIVE_PATH]);
  const paths = tree.stdout.split("\0").filter(Boolean);
  if (!paths.includes(BASELINE_RELATIVE_PATH)) return null;
  const shown = runGit(["show", `${baseRef}:${BASELINE_RELATIVE_PATH}`]);
  return parseBaseline(shown.stdout, `${baseRef}:${BASELINE_RELATIVE_PATH}`);
}

function assertToolVersions(scan, baseline) {
  for (const name of ["knip", "vulture"]) {
    if (scan.tools[name] !== baseline.tools[name]) {
      throw new QualityToolError(
        "BASELINE_TOOL_VERSION",
        `${name} 当前为 ${scan.tools[name]}，基线记录为 ${baseline.tools[name]}。`,
        "升级扫描器时人工复核完整结果，并在同一 PR 更新基线版本。",
      );
    }
  }
}

function formatFinding(finding, prefix) {
  const symbol = finding.symbol ? ` :: ${finding.symbol}` : "";
  const line = finding.line ? `:${finding.line}` : "";
  return `${prefix} [${finding.tool}/${finding.kind}] ${finding.path}${line}${symbol}`;
}

function renderHuman(report) {
  if (report.reportOnly) {
    console.log(
      `quality report-only: ${report.findings.length} findings (knip ${report.counts.knip}, vulture ${report.counts.vulture})`,
    );
    for (const finding of report.findings) console.log(formatFinding(finding, " "));
    return;
  }
  if (report.ok) {
    const bootstrap = report.baseBaselineMissing ? "；base 尚无基线，本 PR 为初始引入" : "";
    console.log(
      `quality: PASS — ${report.findings.length} baseline findings (knip ${report.counts.knip}, vulture ${report.counts.vulture})${bootstrap}`,
    );
    return;
  }
  console.error(`quality: ${report.status}`);
  for (const finding of report.newFindings) console.error(formatFinding(finding, "+"));
  for (const finding of report.staleFindings) console.error(formatFinding(finding, "-"));
  for (const finding of report.baselineAdditions) console.error(formatFinding(finding, "!"));
}

export function parseArgs(argv) {
  const options = { reportOnly: false, deep: false, json: false, baseRef: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--report-only") options.reportOnly = true;
    else if (arg === "--deep") {
      options.deep = true;
      options.reportOnly = true;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--base-ref") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new QualityToolError("INVALID_ARGUMENT", "--base-ref 缺少 git ref。", "传入 PR base SHA。");
      }
      options.baseRef = value;
      index += 1;
    } else {
      throw new QualityToolError(
        "INVALID_ARGUMENT",
        `未知参数：${arg}`,
        "运行 npm run quality -- --help 查看可用参数。",
      );
    }
  }
  return options;
}

export function runQuality(options) {
  const scan = scanFindings({
    minConfidence: options.deep ? 60 : 80,
    knipProduction: options.deep,
  });
  if (options.reportOnly) return { ...scan, reportOnly: true, ok: true, deep: options.deep };

  const baseline = readCurrentBaseline();
  assertToolVersions(scan, baseline);
  const comparison = compareFindings(scan.findings, baseline.findings);
  const baseRef = resolveBaseRef(options.baseRef);
  let baseBaselineMissing = false;
  let baselineAdditions = [];
  const baseBaseline = readBaseBaseline(baseRef);
  if (baseBaseline) baselineAdditions = baselineGrowth(baseline.findings, baseBaseline.findings);
  else baseBaselineMissing = true;
  const ok =
    comparison.newFindings.length === 0 &&
    comparison.staleFindings.length === 0 &&
    baselineAdditions.length === 0;
  const status = comparison.newFindings.length
    ? "FAIL_NEW_FINDING"
    : comparison.staleFindings.length
      ? "FAIL_STALE_BASELINE"
      : baselineAdditions.length
        ? "FAIL_BASELINE_GROWTH"
        : "PASS";
  return {
    ...scan,
    ...comparison,
    baselineAdditions,
    baseBaselineMissing,
    baseRef,
    reportOnly: false,
    ok,
    status,
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(HELP_TEXT);
      return;
    }
    const report = runQuality(options);
    if (options.json) console.log(JSON.stringify(report));
    else renderHuman(report);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof QualityToolError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    console.error(`quality: FAIL_TOOLING [${code}]`);
    console.error(`problem: ${message}`);
    if (error instanceof QualityToolError && error.fix) console.error(`fix: ${error.fix}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) await main();
