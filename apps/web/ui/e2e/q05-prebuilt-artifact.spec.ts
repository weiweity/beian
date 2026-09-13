import { expect, test } from "@playwright/test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, parse } from "node:path";
import {
  Q05_IDENTITY_FILE,
  Q05_IDENTITY_SCHEMA,
  Q05_PREBUILT_ENV,
  buildQ05ArtifactInto,
  cleanupQ05Artifact,
  Q05ArtifactError,
  q05MeasurementWindows,
  resolveQ05Artifact,
} from "./q05Artifact";

const PROD_INDEX = [
  '<!doctype html><html lang="zh-CN"><head>',
  '<link rel="stylesheet" href="/assets/index-abc.css">',
  '</head><body><div id="root"></div>',
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
  "</body></html>",
].join("");

const created: string[] = [];
test.afterEach(() => {
  for (const dir of created.splice(0)) {
    try { chmodSync(dir, 0o755); } catch { /* already writable */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeUiRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "q05-inputs-"));
  created.push(root);
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  const uiRoot = join(root, "apps", "web", "ui");
  mkdirSync(join(uiRoot, "src", "pages"), { recursive: true });
  mkdirSync(join(uiRoot, "public"), { recursive: true });
  writeFileSync(join(uiRoot, "src", "main.tsx"), "export const main = 1;\n");
  writeFileSync(join(uiRoot, "src", "pages", "MockupPage.tsx"), "export const page = 1;\n");
  writeFileSync(join(uiRoot, "index.html"), '<script type="module" src="/src/main.tsx"></script>\n');
  writeFileSync(join(uiRoot, "vite.config.ts"), "export default {};\n");
  writeFileSync(join(uiRoot, "tsconfig.json"), "{}\n");
  writeFileSync(join(uiRoot, "package.json"), '{ "name": "synthetic-ui" }\n');
  return uiRoot;
}

function writeDist(dir: string): void {
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), PROD_INDEX);
  writeFileSync(join(dir, "assets", "index-abc.js"), "console.log(1);\n");
  writeFileSync(join(dir, "assets", "index-abc.css"), "body{}\n");
}

function owned(uiRoot: string) {
  return resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: {},
    build: writeDist,
  });
}

function copyExternal(sourceDir: string): string {
  const dir = mkdtempSync(join(tmpdir(), "q05-prebuilt-"));
  created.push(dir);
  rmSync(dir, { recursive: true, force: true });
  cpSync(sourceDir, dir, { recursive: true });
  return dir;
}

const FORBIDDEN_BUILD = () => {
  throw new Error("预构建模式不得调用构建");
};

test("默认模式：自建临时目录、写入身份、cleanup 只删该目录", () => {
  const uiRoot = makeUiRoot();
  let builds = 0;
  const source = resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: {},
    build: (dir) => { builds += 1; writeDist(dir); },
  });
  created.push(source.dir);
  expect(builds).toBe(1);
  expect(source.mode).toBe("built-temp");
  expect(source.owned).toBe(true);
  expect(source.identity.schema).toBe(Q05_IDENTITY_SCHEMA);
  expect(existsSync(join(source.dir, Q05_IDENTITY_FILE))).toBe(true);
  expect([...source.assets.keys()].sort()).toEqual([
    "/assets/index-abc.css",
    "/assets/index-abc.js",
  ]);
  expect(q05MeasurementWindows(source).heap_raf.includes_ui_build).toBe(false);
  expect(q05MeasurementWindows(source).command_rss_wall.includes_ui_build).toBe(true);
  cleanupQ05Artifact(source);
  expect(existsSync(source.dir)).toBe(false);
});

test("默认模式：构建失败时删除自建目录，不回退到外部路径", () => {
  const uiRoot = makeUiRoot();
  const before = mkdtempSync(join(tmpdir(), "q05-sentinel-"));
  created.push(before);
  expect(() => resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: {},
    build: () => { throw new Error("vite failed"); },
  })).toThrow(/vite failed/);
  expect(existsSync(before)).toBe(true);
});

test("默认模式：构建期间源码变化则失败并删除自建目录", () => {
  const uiRoot = makeUiRoot();
  expect(() => resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: {},
    build: (dir) => {
      writeFileSync(join(uiRoot, "src", "main.tsx"), "export const main = 2;\n");
      writeDist(dir);
    },
  })).toThrow(/构建期间源码\/配置\/依赖变化/);
});

test("预构建模式：合法产物不构建、不删外部目录，整命令窗口不含构建", () => {
  const uiRoot = makeUiRoot();
  const built = owned(uiRoot);
  const external = copyExternal(built.dir);
  cleanupQ05Artifact(built);
  let builds = 0;
  const source = resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: external },
    build: () => { builds += 1; },
  });
  expect(builds).toBe(0);
  expect(source.mode).toBe("prebuilt-external");
  expect(source.owned).toBe(false);
  expect(source.dir).toBe(realpathSync(external));
  expect(q05MeasurementWindows(source).heap_raf.includes_ui_build).toBe(false);
  expect(q05MeasurementWindows(source).command_rss_wall.includes_ui_build).toBe(false);
  cleanupQ05Artifact(source);
  expect(existsSync(join(external, "index.html"))).toBe(true);
  expect(existsSync(join(external, Q05_IDENTITY_FILE))).toBe(true);
});

test("预构建模式：目录不存在时失败关闭，且不调用构建", () => {
  const uiRoot = makeUiRoot();
  const missing = join(tmpdir(), `q05-absent-${process.pid}`);
  let builds = 0;
  expect(() => resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: missing },
    build: () => { builds += 1; },
  })).toThrow(Q05ArtifactError);
  expect(builds).toBe(0);
  expect(existsSync(missing)).toBe(false);
});

test("预构建模式：变量已设置但为空时失败关闭，不回退构建", () => {
  const uiRoot = makeUiRoot();
  expect(() => resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: "   " },
    build: FORBIDDEN_BUILD,
  })).toThrow(/已设置但路径为空/);
});

test("buildQ05ArtifactInto：仓库外空目录可构建，cleanup 不删除", () => {
  const uiRoot = makeUiRoot();
  const dir = mkdtempSync(join(tmpdir(), "q05-prebuilt-"));
  created.push(dir);
  const source = buildQ05ArtifactInto(dir, {
    uiRoot,
    gitHead: () => "abc123",
    build: writeDist,
  });
  expect(source.owned).toBe(false);
  expect(existsSync(join(dir, Q05_IDENTITY_FILE))).toBe(true);
  cleanupQ05Artifact(source);
  expect(existsSync(dir)).toBe(true);
});

test("buildQ05ArtifactInto：构建失败保留外部目录和部分产物", () => {
  const uiRoot = makeUiRoot();
  const dir = mkdtempSync(join(tmpdir(), "q05-prebuilt-"));
  created.push(dir);
  expect(() => buildQ05ArtifactInto(dir, {
    uiRoot,
    gitHead: () => "abc123",
    build: (dest) => {
      writeFileSync(join(dest, "partial"), "keep me");
      throw new Error("vite failed");
    },
  })).toThrow(/vite failed/);
  expect(existsSync(dir)).toBe(true);
  expect(readFileSync(join(dir, "partial"), "utf8")).toBe("keep me");
  expect(existsSync(join(dir, Q05_IDENTITY_FILE))).toBe(false);
});

test("buildQ05ArtifactInto：非空目录及符号链接别名在 build 前拒绝，sentinel 字节不变", () => {
  const uiRoot = makeUiRoot();
  const root = mkdtempSync(join(tmpdir(), "q05-target-"));
  created.push(root);
  const dir = join(root, "output");
  mkdirSync(dir);
  const bytes = Buffer.from([0, 255, 13, 10, 42]);
  writeFileSync(join(dir, ".sentinel"), bytes);
  symlinkSync(dir, join(root, "alias"), "dir");
  for (const target of [dir, join(root, "alias"), resolve(dir, "..", "output")]) {
    let builds = 0;
    expect(() => buildQ05ArtifactInto(target, {
      uiRoot, gitHead: () => "abc123", build: () => { builds += 1; },
    })).toThrow(/构建目的目录/);
    expect(builds).toBe(0);
    expect(readFileSync(join(dir, ".sentinel"))).toEqual(bytes);
  }
});

test("buildQ05ArtifactInto：源码树、仓库内部（含 .git 文件）、宽泛目标及路径别名拒绝", () => {
  const uiRoot = makeUiRoot();
  const repo = resolve(uiRoot, "../../..");
  const empty = join(repo, "empty-output");
  mkdirSync(empty);
  const aliases = mkdtempSync(join(tmpdir(), "q05-alias-"));
  created.push(aliases);
  symlinkSync(repo, join(aliases, "repo"), "dir");
  symlinkSync(uiRoot, join(aliases, "ui"), "dir");
  const assertRejected = (target: string) => {
    let builds = 0;
    expect(() => buildQ05ArtifactInto(target, {
      uiRoot: join(aliases, "ui"), gitHead: () => "abc123", build: () => { builds += 1; },
    })).toThrow(/构建目的目录/);
    expect(builds).toBe(0);
  };
  for (const target of [uiRoot, join(uiRoot, "public"), repo, homedir(), tmpdir(), parse(repo).root]) {
    assertRejected(target);
  }
  for (const name of ["Volumes", "mnt", "Users", "Windows"]) {
    const target = join(parse(repo).root, name);
    if (existsSync(target)) assertRejected(target);
  }
  for (const gitKind of ["file", "directory"]) {
    if (gitKind === "file") writeFileSync(join(repo, ".git"), "gitdir: /unused/synthetic\n");
    else {
      rmSync(join(repo, ".git"));
      mkdirSync(join(repo, ".git"));
    }
    for (const target of [empty, join(aliases, "repo", "empty-output")]) assertRejected(target);
  }
});

test("预构建模式：缺少身份记录时失败关闭，不删外部目录", () => {
  const uiRoot = makeUiRoot();
  const dir = mkdtempSync(join(tmpdir(), "q05-prebuilt-"));
  created.push(dir);
  writeDist(dir);
  expect(() => resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: dir },
    build: FORBIDDEN_BUILD,
  })).toThrow(/缺少身份记录/);
  expect(existsSync(join(dir, "index.html"))).toBe(true);
});

test("预构建模式：拒绝开发服务器入口，不删外部目录", () => {
  const uiRoot = makeUiRoot();
  const dir = mkdtempSync(join(tmpdir(), "q05-prebuilt-"));
  created.push(dir);
  writeDist(dir);
  writeFileSync(join(dir, "index.html"), '<script type="module" src="/src/main.tsx"></script>');
  expect(() => resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: dir },
    build: FORBIDDEN_BUILD,
  })).toThrow(/开发入口/);
  expect(existsSync(dir)).toBe(true);
});

test("预构建模式：index.html 引用的资源缺失时失败关闭", () => {
  const uiRoot = makeUiRoot();
  const dir = mkdtempSync(join(tmpdir(), "q05-prebuilt-"));
  created.push(dir);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), PROD_INDEX);
  expect(() => resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: dir },
    build: FORBIDDEN_BUILD,
  })).toThrow(/hashed JS|缺失或为空/);
  expect(existsSync(dir)).toBe(true);
});

test("预构建模式：源码变化后拒绝过期产物，不回退构建、不删外部目录", () => {
  const uiRoot = makeUiRoot();
  const built = owned(uiRoot);
  const external = copyExternal(built.dir);
  cleanupQ05Artifact(built);
  writeFileSync(join(uiRoot, "src", "pages", "extra.ts"), "export const extra = 2;\n");
  expect(() => resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: external },
    build: FORBIDDEN_BUILD,
  })).toThrow(/不一致/);
  expect(existsSync(join(external, "index.html"))).toBe(true);
});

test("预构建模式：gitHead 不匹配时失败关闭", () => {
  const uiRoot = makeUiRoot();
  const built = owned(uiRoot);
  const external = copyExternal(built.dir);
  cleanupQ05Artifact(built);
  expect(() => resolveQ05Artifact({
    uiRoot,
    gitHead: () => "other-head",
    env: { [Q05_PREBUILT_ENV]: external },
    build: FORBIDDEN_BUILD,
  })).toThrow(/gitHead/);
  expect(existsSync(external)).toBe(true);
});

test("预构建模式：产物字节被改写时失败关闭", () => {
  const uiRoot = makeUiRoot();
  const built = owned(uiRoot);
  const external = copyExternal(built.dir);
  cleanupQ05Artifact(built);
  writeFileSync(join(external, "assets", "index-abc.js"), "console.log(2);\n");
  expect(() => resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: external },
    build: FORBIDDEN_BUILD,
  })).toThrow(/与身份记录不一致/);
  expect(existsSync(external)).toBe(true);
});

test("预构建模式：校验后磁盘被覆盖仍供给快照字节", () => {
  const uiRoot = makeUiRoot();
  const built = owned(uiRoot);
  const external = copyExternal(built.dir);
  cleanupQ05Artifact(built);
  const source = resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: external },
    build: FORBIDDEN_BUILD,
  });
  const originalJs = source.assets.get("/assets/index-abc.js")!.toString("utf8");
  writeFileSync(join(external, "index.html"), "<html>tampered</html>");
  writeFileSync(join(external, "assets", "index-abc.js"), "tampered();\n");
  expect(source.indexHtml.toString("utf8")).toContain("/assets/index-abc.js");
  expect(source.assets.get("/assets/index-abc.js")!.toString("utf8")).toBe(originalJs);
  expect(source.assets.get("/assets/index-abc.js")!.toString("utf8")).not.toBe("tampered();\n");
});

test("预构建模式：只读外部目录仍可复用，且不会被 cleanup 删除", () => {
  const uiRoot = makeUiRoot();
  const built = owned(uiRoot);
  const external = copyExternal(built.dir);
  cleanupQ05Artifact(built);
  const files = ["index.html", Q05_IDENTITY_FILE, "assets/index-abc.js", "assets/index-abc.css"];
  const before = files.map((file) => readFileSync(join(external, file)));
  chmodSync(external, 0o555);
  const source = resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: external },
    build: FORBIDDEN_BUILD,
  });
  expect(source.owned).toBe(false);
  cleanupQ05Artifact(source);
  expect(existsSync(join(external, "index.html"))).toBe(true);
  expect(readFileSync(join(external, Q05_IDENTITY_FILE), "utf8")).toContain(Q05_IDENTITY_SCHEMA);
  expect(files.map((file) => readFileSync(join(external, file)))).toEqual(before);
});

test("cleanupQ05Artifact：未持有时不删任何目录", () => {
  const uiRoot = makeUiRoot();
  const built = owned(uiRoot);
  const external = copyExternal(built.dir);
  cleanupQ05Artifact(built);
  const source = resolveQ05Artifact({
    uiRoot,
    gitHead: () => "abc123",
    env: { [Q05_PREBUILT_ENV]: external },
    build: FORBIDDEN_BUILD,
  });
  cleanupQ05Artifact(undefined);
  cleanupQ05Artifact(source);
  expect(existsSync(external)).toBe(true);
});
