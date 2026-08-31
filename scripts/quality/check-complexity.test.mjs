import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  QualityToolError,
  baselineGrowth,
  compareFindings,
  findingKey,
  normalizeKnipReport,
  parseArgs,
  parseBaseline,
  parseVultureOutput,
  readBaseBaseline,
  resolveBaseRef,
  runTool,
  sortFindings,
} from "./check-complexity.mjs";

const root = resolve(import.meta.dirname, "../..");

function finding(symbol, overrides = {}) {
  return {
    tool: "knip",
    kind: "exports",
    path: "apps/web/server/src/example.ts",
    symbol,
    line: 10,
    confidence: 100,
    ...overrides,
  };
}

describe("complexity baseline contract", () => {
  it("passes an exact baseline", () => {
    assert.deepEqual(compareFindings([finding("same")], [finding("same", { line: 2 })]), {
      newFindings: [],
      staleFindings: [],
    });
  });

  it("reports new findings without mutating the baseline", () => {
    const baseline = [finding("known")];
    const before = structuredClone(baseline);
    const result = compareFindings([...baseline, finding("new")], baseline);
    assert.deepEqual(result.newFindings.map((entry) => entry.symbol), ["new"]);
    assert.deepEqual(result.staleFindings, []);
    assert.deepEqual(baseline, before);
  });

  it("reports stale entries so the baseline must shrink", () => {
    const result = compareFindings([], [finding("removed")]);
    assert.deepEqual(result.newFindings, []);
    assert.deepEqual(result.staleFindings.map((entry) => entry.symbol), ["removed"]);
  });

  it("rejects baseline growth relative to the PR base", () => {
    assert.deepEqual(
      baselineGrowth([finding("known"), finding("smuggled")], [finding("known")]).map((entry) => entry.symbol),
      ["smuggled"],
    );
  });

  it("rejects exactly duplicated or malformed baseline entries", () => {
    const duplicate = JSON.stringify({
      schema_version: 1,
      tools: { knip: "6.32.2", vulture: "2.16" },
      policy: { vulture_min_confidence: 80, knip_mode: "repository" },
      findings: [finding("same"), finding("same")],
    });
    assert.throws(() => parseBaseline(duplicate), (error) => error.code === "MALFORMED_BASELINE");
  });

  it("allows repeated diagnostics at different lines so multiplicity stays visible", () => {
    const repeated = JSON.stringify({
      schema_version: 1,
      tools: { knip: "6.32.2", vulture: "2.16" },
      policy: { vulture_min_confidence: 80, knip_mode: "repository" },
      findings: [finding("same", { line: 2 }), finding("same", { line: 99 })],
    });
    assert.equal(parseBaseline(repeated).findings.length, 2);
  });

  it("compares repeated diagnostics as a multiset while ignoring line movement", () => {
    const baseline = [finding("same", { line: 90 })];
    const actual = [finding("same", { line: 2 }), finding("same", { line: 20 })];
    const growth = compareFindings(actual, baseline);
    assert.deepEqual(growth.newFindings.map((entry) => entry.line), [20]);
    assert.deepEqual(growth.staleFindings, []);

    const shrink = compareFindings(baseline, actual);
    assert.deepEqual(shrink.newFindings, []);
    assert.deepEqual(shrink.staleFindings.map((entry) => entry.line), [20]);
    assert.deepEqual(baselineGrowth(actual, baseline).map((entry) => entry.line), [20]);
  });

  it("preserves exactly duplicated scanner findings so multiplicity cannot pass silently", () => {
    const duplicate = finding("same");
    const result = compareFindings([duplicate, duplicate], [duplicate]);
    assert.deepEqual(result.newFindings.map((entry) => entry.symbol), ["same"]);
    assert.deepEqual(result.staleFindings, []);
    assert.deepEqual(baselineGrowth([duplicate, duplicate], [duplicate]).map((entry) => entry.symbol), ["same"]);
  });

  it("rejects a baseline whose stable identities are not sorted", () => {
    const unsorted = JSON.stringify({
      schema_version: 1,
      tools: { knip: "6.32.2", vulture: "2.16" },
      policy: { vulture_min_confidence: 80, knip_mode: "repository" },
      findings: [finding("z-last"), finding("a-first")],
    });
    assert.throws(() => parseBaseline(unsorted), (error) => error.code === "MALFORMED_BASELINE");
  });
});

describe("scanner adapters", () => {
  it("normalizes Knip files and symbols", () => {
    const result = normalizeKnipReport(
      {
        issues: [
          { file: "unused.ts", files: [{ name: "unused.ts" }], exports: [] },
          { file: "used.ts", files: [], exports: [{ name: "orphan", line: 4 }] },
        ],
      },
      "/repo",
    );
    assert.deepEqual(
      result.map(({ kind, path, symbol }) => ({ kind, path, symbol })),
      [
        { kind: "exports", path: "used.ts", symbol: "orphan" },
        { kind: "file", path: "unused.ts", symbol: "" },
      ],
    );
  });

  it("normalizes Knip nested duplicates and cycles while ignoring owners metadata", () => {
    const result = normalizeKnipReport(
      {
        issues: [
          {
            file: "src/repeated.ts",
            owners: [{ name: "@maintainers" }],
            duplicates: [[{ name: "repeat", line: 4 }, { name: "repeat", line: 9 }]],
            cycles: [[{ name: "src/other.ts", line: 12 }]],
          },
        ],
      },
      "/repo",
    );
    assert.deepEqual(
      result.map(({ kind, path, symbol, line }) => ({ kind, path, symbol, line })),
      [
        { kind: "cycles", path: "src/repeated.ts", symbol: "src/other.ts", line: 12 },
        { kind: "duplicates", path: "src/repeated.ts", symbol: "repeat", line: 4 },
        { kind: "duplicates", path: "src/repeated.ts", symbol: "repeat", line: 9 },
      ],
    );
  });

  it("normalizes Vulture unused and reachability output and fails closed on format drift", () => {
    assert.deepEqual(
      parseVultureOutput("app/a.py:7: unused function 'legacy' (90% confidence, 2 lines)", "/repo")[0],
      {
        tool: "vulture",
        kind: "function",
        path: "app/a.py",
        symbol: "legacy",
        line: 7,
        confidence: 90,
      },
    );
    assert.deepEqual(
      parseVultureOutput(
        [
          "app/a.py:3: unreachable code after 'return' (100% confidence)",
          "app/b.py:5: unsatisfiable 'if' condition (100% confidence, 4 lines)",
        ].join("\n"),
        "/repo",
      ).map(({ kind, path, symbol, confidence }) => ({ kind, path, symbol, confidence })),
      [
        {
          kind: "unreachable_code",
          path: "app/a.py",
          symbol: "unreachable code after 'return'",
          confidence: 100,
        },
        {
          kind: "unreachable_code",
          path: "app/b.py",
          symbol: "unsatisfiable 'if' condition",
          confidence: 100,
        },
      ],
    );
    assert.throws(
      () => parseVultureOutput("new output format", "/repo"),
      (error) => error.code === "MALFORMED_VULTURE_OUTPUT",
    );
    assert.throws(
      () => parseVultureOutput("app/a.py:7: future vulture message (90% confidence)", "/repo"),
      (error) => error.code === "MALFORMED_VULTURE_OUTPUT",
    );
  });

  it("sorts findings and preserves exact and line-distinct repeated diagnostics", () => {
    const result = sortFindings([
      finding("b"),
      finding("a", { line: 20 }),
      finding("a", { line: 2 }),
      finding("a", { line: 2 }),
    ]);
    assert.deepEqual(
      result.map(({ symbol, line }) => ({ symbol, line })),
      [
        { symbol: "a", line: 2 },
        { symbol: "a", line: 2 },
        { symbol: "a", line: 20 },
        { symbol: "b", line: 10 },
      ],
    );
  });

  it("uses an unambiguous stable identity for scanner fields", () => {
    assert.notEqual(
      findingKey(finding("c", { kind: "a\u0000b" })),
      findingKey(finding("b\u0000c", { kind: "a" })),
    );
  });
});

describe("tool failure contract", () => {
  it("reports a missing executable", () => {
    assert.throws(
      () => runTool("/definitely/missing/beian-quality-tool", []),
      (error) => error instanceof QualityToolError && error.code === "TOOL_MISSING",
    );
  });

  it("times out a stuck child", () => {
    const dir = mkdtempSync(join(tmpdir(), "beian-quality-timeout-"));
    const script = join(dir, "hang.mjs");
    try {
      writeFileSync(script, "setInterval(() => {}, 1000);\n", "utf8");
      assert.throws(
        () => runTool(process.execPath, [script], { timeoutMs: 50 }),
        (error) => error instanceof QualityToolError && error.code === "TOOL_TIMEOUT",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts Vulture's findings exit code", () => {
    assert.equal(
      runTool(process.execPath, ["-e", "process.exit(3)"], { allowedStatuses: [0, 3] }).status,
      3,
    );
  });

  it("rejects unknown CLI flags", () => {
    assert.throws(() => parseArgs(["--rewrite-baseline"]), (error) => error.code === "INVALID_ARGUMENT");
    assert.deepEqual(parseArgs(["--deep", "--json"]), {
      reportOnly: true,
      deep: true,
      json: true,
      baseRef: "",
      help: false,
    });
  });

  it("prints stable CLI help without requiring scanner dependencies", () => {
    const script = join(root, "scripts/quality/check-complexity.mjs");
    const result = runTool(process.execPath, [script, "--help"]);
    assert.match(result.stdout, /npm ci --prefix tools\/quality/);
    assert.match(result.stdout, /--base-ref <git-ref>/);
  });

  it("uses an explicit base ref without consulting git", () => {
    assert.equal(
      resolveBaseRef("release/base", {
        env: {},
        runGit: () => assert.fail("git should not run for an explicit base"),
      }),
      "release/base",
    );
  });

  it("discovers the target branch from origin HEAD", () => {
    const runGit = (args) => {
      if (args[0] === "symbolic-ref") return { status: 0, stdout: "origin/trunk\n", stderr: "" };
      if (args[0] === "rev-parse") {
        return { status: args.at(-1) === "origin/trunk^{commit}" ? 0 : 1, stdout: "", stderr: "" };
      }
      assert.fail(`unexpected git call: ${args.join(" ")}`);
    };
    assert.equal(resolveBaseRef("", { env: {}, runGit }), "origin/trunk");
  });

  it("prefers the GitHub PR base and fails closed when no target exists", () => {
    const githubRunGit = (args) => {
      if (args[0] === "symbolic-ref") return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") {
        return { status: args.at(-1) === "origin/release^{commit}" ? 0 : 1, stdout: "", stderr: "" };
      }
      assert.fail(`unexpected git call: ${args.join(" ")}`);
    };
    assert.equal(
      resolveBaseRef("", { env: { GITHUB_BASE_REF: "release" }, runGit: githubRunGit }),
      "origin/release",
    );

    const missingRunGit = (args) =>
      args[0] === "symbolic-ref"
        ? { status: 1, stdout: "", stderr: "" }
        : { status: 1, stdout: "", stderr: "" };
    assert.throws(
      () => resolveBaseRef("", { env: {}, runGit: missingRunGit }),
      (error) => error.code === "BASE_REF_MISSING",
    );
    assert.throws(() => resolveBaseRef("--upload-pack=evil"), (error) => error.code === "INVALID_BASE_REF");
  });

  it("checks base baseline presence without parsing localized Git errors", () => {
    const calls = [];
    const runGit = (args) => {
      calls.push(args);
      if (args[0] === "cat-file") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "ls-tree") return { status: 0, stdout: "", stderr: "本地化错误文本不参与判断" };
      assert.fail(`unexpected git call: ${args.join(" ")}`);
    };
    assert.equal(readBaseBaseline("base-sha", { runGit }), null);
    assert.deepEqual(calls.map((args) => args[0]), ["cat-file", "ls-tree"]);
  });
});

describe("repository quality policy", () => {
  it("keeps dynamic runtime entries explicit in Knip", () => {
    const config = JSON.parse(readFileSync(join(root, "knip.json"), "utf8"));
    const entries = config.workspaces["."].entry;
    assert.ok(entries.includes("scripts/windows/release-dependency-check.mjs!"));
    assert.ok(entries.includes("workers/packaging/ppt/build_product_ppt.mjs!"));
    assert.ok(entries.includes("workers/packaging/illustrator/export_ai.jsx!"));
    assert.ok(entries.includes("workers/packaging/illustrator/export_structure.jsx!"));
    assert.ok(entries.includes("workers/packaging/illustrator/curve_flatten.js!"));
    assert.ok(entries.includes("workers/packaging/illustrator/runner_probe.jsx!"));
    assert.ok(!entries.some((entry) => entry.includes("illustrator/*.jsx")));
    assert.ok(config.workspaces["apps/web/server"].entry.includes("src/index.ts!"));
    assert.ok(config.workspaces["apps/web/ui"].entry.includes("src/main.tsx!"));
    assert.ok(config.workspaces["apps/web/ui"].project.includes("e2e/**/*.ts"));
    assert.ok(config.workspaces["."].project.includes("scripts/**/*.{js,cjs,mjs,jsx,ts,tsx}!"));
  });

  it("finds orphan files in scripts and Playwright support code", () => {
    const probes = [
      join(root, "scripts/quality/__quality_orphan_probe.js"),
      join(root, "apps/web/ui/e2e/__quality_orphan_probe.ts"),
    ];
    const knip = join(
      root,
      "tools/quality/node_modules/.bin",
      process.platform === "win32" ? "knip.cmd" : "knip",
    );
    try {
      for (const probe of probes) writeFileSync(probe, "export const orphanProbe = 1;\n", "utf8");
      const result = runTool(
        knip,
        ["--config", "knip.json", "--reporter", "json", "--no-progress", "--no-config-hints"],
        { allowedStatuses: [0, 1] },
      );
      const findings = normalizeKnipReport(JSON.parse(result.stdout));
      const paths = new Set(findings.filter((entry) => entry.kind === "file").map((entry) => entry.path));
      assert.ok(paths.has("scripts/quality/__quality_orphan_probe.js"));
      assert.ok(paths.has("apps/web/ui/e2e/__quality_orphan_probe.ts"));
    } finally {
      for (const probe of probes) rmSync(probe, { force: true });
    }
  });

  it("keeps Vulture out of production requirements", () => {
    const production = readFileSync(join(root, "apps/web/backend/requirements.txt"), "utf8");
    const quality = readFileSync(join(root, "apps/web/backend/requirements-quality.txt"), "utf8");
    assert.doesNotMatch(production, /^vulture\b/im);
    assert.match(quality, /^vulture==2\.16$/m);
  });

  it("keeps Knip out of the production dependency fingerprint", () => {
    const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const qualityPackage = JSON.parse(readFileSync(join(root, "tools/quality/package.json"), "utf8"));
    assert.equal(rootPackage.devDependencies?.knip, undefined);
    assert.equal(qualityPackage.devDependencies.knip, "6.32.2");
    assert.equal(rootPackage.engines.node, ">=20");
    assert.match(qualityPackage.engines.node, /20\.19\.0/);
    assert.doesNotMatch(rootPackage.scripts.test, /quality/);
  });

  it("isolates PR quality checks from Hangzhou production", () => {
    const quality = readFileSync(join(root, ".github/workflows/quality.yml"), "utf8");
    const production = readFileSync(join(root, ".github/workflows/hangzhou-release.yml"), "utf8");
    assert.match(quality, /^\s{2}pull_request:\s*$/m);
    assert.match(quality, /runs-on:\s*ubuntu-latest/);
    assert.match(quality, /timeout-minutes:\s*12/);
    assert.match(quality, /cancel-in-progress:\s*true/);
    assert.match(quality, /npm run quality/);
    assert.match(quality, /npm run test:quality/);
    assert.match(quality, /npm test/);
    assert.doesNotMatch(quality, /npm ci --prefix apps\/web\/ui/);
    assert.match(quality, /require\.resolve\('@rollup\/rollup-linux-x64-gnu'/);
    assert.match(quality, /apps\/web\/ui\/node_modules\/rollup\/package\.json/);
    assert.match(quality, /--no-save --package-lock=false --ignore-scripts/);
    assert.doesNotMatch(quality, /self-hosted|hangzhou|release\.ps1|environment:/i);
    assert.match(quality, /npm run typecheck/);
    assert.ok(
      quality.indexOf("run: npm run typecheck") < quality.indexOf("run: npm test"),
      "UI build must exist before server SPA tests run in a clean checkout",
    );
    assert.match(production, /runs-on:\s*\[self-hosted, hangzhou\]/);
    assert.doesNotMatch(production, /^\s{2}pull_request:\s*$/m);
  });
});
