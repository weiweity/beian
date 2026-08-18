import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { DATA_DIR, PYTHON_APP } from "./config.js";

export type FieldKind = "text" | "secret" | "toggle" | "path";

export type SettingField = {
  key: string;
  label: string;
  kind: FieldKind;
  help: string;
  group: string;
  restart?: boolean;
  default?: string;
};

function defaultPython(): string {
  const win = join(PYTHON_APP, ".venv/Scripts/python.exe");
  const nix = join(PYTHON_APP, ".venv/bin/python");
  if (existsSync(win)) return win;
  return nix;
}

export const CATALOG: SettingField[] = [
  {
    group: "飞书登录",
    key: "FEISHU_APP_ID",
    label: "应用 App ID",
    kind: "text",
    help: "飞书开放平台网页应用。换租户时改这里，不用改代码。",
    default: "",
  },
  {
    group: "飞书登录",
    key: "FEISHU_APP_SECRET",
    label: "应用 Secret",
    kind: "secret",
    help: "只存在本机。保存后界面只显示是否已填。",
  },
  {
    group: "飞书登录",
    key: "WB_PUBLIC_BASE",
    label: "对外网址",
    kind: "text",
    help: "例如 https://www.jianghua.site。回调和推送链接用它。",
    default: "https://www.jianghua.site",
  },
  {
    group: "飞书登录",
    key: "FEISHU_REDIRECT_URI",
    label: "OAuth 回调",
    kind: "text",
    help: "须与飞书控制台一致。空则用「对外网址」+/api/auth/feishu/callback。",
  },
  {
    group: "飞书登录",
    key: "FEISHU_ALLOW_OPEN_IDS",
    label: "额外白名单 open_id",
    kind: "text",
    help: "逗号分隔 ou_…。也可写在本机 users.json。",
  },
  {
    group: "飞书登录",
    key: "WB_PUBLIC",
    label: "公网模式",
    kind: "toggle",
    restart: true,
    help: "打开后关闭显示名登录，只走飞书。Tunnel 对外前打开。",
    default: "false",
  },
  {
    group: "飞书登录",
    key: "WB_DEV_DISPLAY_LOGIN",
    label: "允许显示名登录",
    kind: "toggle",
    help: "仅本机调试。公网模式打开时无效。",
    default: "true",
  },
  {
    group: "飞书推送",
    key: "FEISHU_ENABLED",
    label: "启用 lark-cli 推送",
    kind: "toggle",
    help: "签字后给指定人发消息。本机要装 lark-cli。",
    default: "false",
  },
  {
    group: "飞书推送",
    key: "FEISHU_OPEN_ID",
    label: "推送对象 open_id",
    kind: "text",
    help: "收「待设计改稿」的那个人。",
  },
  {
    group: "飞书推送",
    key: "FEISHU_AS",
    label: "以谁发送",
    kind: "text",
    help: "一般填 bot。",
    default: "bot",
  },
  {
    group: "百度 OCR",
    key: "BAIDU_OCR_API_KEY",
    label: "API Key",
    kind: "secret",
    help: "对照包装字用。没有则机审几乎不能跑。",
  },
  {
    group: "百度 OCR",
    key: "BAIDU_OCR_SECRET_KEY",
    label: "Secret Key",
    kind: "secret",
    help: "与 API Key 成对。",
  },
  {
    group: "百度 OCR",
    key: "BAIDU_OCR_API",
    label: "接口",
    kind: "text",
    help: "默认 accurate（带位置）。不要随便改。",
    default: "accurate",
  },
  {
    group: "MiniMax（可选）",
    key: "MINIMAX_ENABLED",
    label: "启用语义复核",
    kind: "toggle",
    help: "关了不影响主对照。",
    default: "false",
  },
  {
    group: "MiniMax（可选）",
    key: "MINIMAX_API_KEY",
    label: "API Key",
    kind: "secret",
    help: "可选。",
  },
  {
    group: "MiniMax（可选）",
    key: "MINIMAX_MODEL",
    label: "模型名",
    kind: "text",
    default: "MiniMax-M3",
    help: "默认 MiniMax-M3。",
  },
  {
    group: "本机依赖",
    key: "WB_PYTHON",
    label: "Python 解释器",
    kind: "path",
    help: "对照 worker 用。一般是 apps/web/backend/.venv 里的 python。",
    default: defaultPython(),
  },
  {
    group: "本机依赖",
    key: "BLENDER_EXECUTABLE",
    label: "Blender 路径",
    kind: "path",
    help: "打样台要这个。必须是可执行文件，不能只写 blender。",
  },
  {
    group: "本机依赖",
    key: "WB_MAX_UPLOAD_MB",
    label: "上传上限 MB",
    kind: "text",
    default: "200",
    help: "单个 Excel/PDF。",
  },
  {
    group: "本机依赖",
    key: "WB_DATA_DIR",
    label: "数据目录",
    kind: "path",
    restart: true,
    help: "任务和密钥落盘处。生产必须在仓库外。改完要重启服务。",
  },
];

const SECRET_KEYS = new Set(CATALOG.filter((f) => f.kind === "secret").map((f) => f.key));

/** Python 旧代码还认 BAIDU_API_KEY 别名。 */
const ALIASES: Record<string, string[]> = {
  BAIDU_OCR_API_KEY: ["BAIDU_API_KEY"],
  BAIDU_OCR_SECRET_KEY: ["BAIDU_SECRET_KEY"],
};

type Store = Record<string, string>;

function storeDir(): string {
  const env = (process.env.WB_DATA_DIR || "").trim();
  return env ? resolve(env) : DATA_DIR;
}

function publicPath() {
  return join(storeDir(), "settings.json");
}

function secretPath() {
  return join(storeDir(), "settings.secrets.json");
}

function readJson(path: string): Store {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeJson(path: string, data: Store, mode = 0o600): void {
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    chmodSync(path, mode);
  } catch {
    /* windows */
  }
}

export function loadStore(): Store {
  return { ...readJson(publicPath()), ...readJson(secretPath()) };
}

export function getSetting(key: string): string {
  const stored = loadStore()[key];
  if (stored != null && stored !== "") return stored;
  const env = process.env[key];
  if (env != null && env !== "") return env;
  return CATALOG.find((f) => f.key === key)?.default || "";
}

function writeEnv(key: string, value: string): void {
  process.env[key] = value;
  for (const alias of ALIASES[key] || []) process.env[alias] = value;
}

function clearEnv(key: string): void {
  delete process.env[key];
  for (const alias of ALIASES[key] || []) delete process.env[alias];
}

export function applyToEnv(): void {
  for (const [k, v] of Object.entries(loadStore())) {
    if (v) writeEnv(k, v);
  }
}

export function saveSettings(patch: Record<string, string>): { restart: boolean } {
  const allowed = new Set(CATALOG.map((f) => f.key));
  const pub = readJson(publicPath());
  const sec = readJson(secretPath());
  let restart = false;
  for (const [k, raw] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    const v = raw.trim();
    const field = CATALOG.find((f) => f.key === k);
    if (SECRET_KEYS.has(k) && v === "") continue;
    if (SECRET_KEYS.has(k)) sec[k] = v;
    else if (v === "") delete pub[k];
    else pub[k] = v;
    if (v) writeEnv(k, v);
    else if (!SECRET_KEYS.has(k)) clearEnv(k);
    if (field?.restart && v) restart = true;
  }
  writeJson(publicPath(), pub, 0o600);
  writeJson(secretPath(), sec, 0o600);
  return { restart };
}

function last4(v: string): string {
  if (v.length <= 4) return "已填";
  return `…${v.slice(-4)}`;
}

export function publicBase(): string {
  return (getSetting("WB_PUBLIC_BASE") || "https://www.jianghua.site").replace(/\/$/, "");
}

export function feishuRedirect(): string {
  return getSetting("FEISHU_REDIRECT_URI") || `${publicBase()}/api/auth/feishu/callback`;
}

export function pythonBin(): string {
  const configured = getSetting("WB_PYTHON");
  if (configured && existsSync(configured)) return configured;
  const fallback = defaultPython();
  return existsSync(fallback) ? fallback : "python3";
}

export function blenderBin(): string {
  return getSetting("BLENDER_EXECUTABLE");
}

export function maxUploadBytes(): number {
  const n = Number(getSetting("WB_MAX_UPLOAD_MB") || "200");
  const mb = Number.isFinite(n) && n > 0 ? n : 200;
  return Math.min(mb, 2048) * 1024 * 1024;
}

export function publicView() {
  const groups = new Map<string, ReturnType<typeof fieldView>[]>();
  for (const f of CATALOG) {
    const val = getSetting(f.key);
    const row = fieldView(f, val);
    const list = groups.get(f.group) || [];
    list.push(row);
    groups.set(f.group, list);
  }
  return {
    groups: [...groups.entries()].map(([title, fields]) => ({ title, fields })),
    probes: [
      { id: "feishu", label: "飞书应用" },
      { id: "baidu", label: "百度 OCR" },
      { id: "python", label: "对照 Python" },
      { id: "blender", label: "Blender" },
      { id: "lark", label: "lark-cli 推送" },
    ],
  };
}

function fieldView(f: SettingField, val: string) {
  if (f.kind === "secret") {
    return {
      key: f.key,
      label: f.label,
      kind: f.kind,
      help: f.help,
      restart: Boolean(f.restart),
      set: Boolean(val),
      last4: val ? last4(val) : "",
      value: "",
    };
  }
  if (f.kind === "toggle") {
    return {
      key: f.key,
      label: f.label,
      kind: f.kind,
      help: f.help,
      restart: Boolean(f.restart),
      set: true,
      last4: "",
      value: /^(1|true|yes|on)$/i.test(val) ? "true" : "false",
    };
  }
  return {
    key: f.key,
    label: f.label,
    kind: f.kind,
    help: f.help,
    restart: Boolean(f.restart),
    set: Boolean(val),
    last4: "",
    value: val,
  };
}

export type ProbeResult = { id: string; ok: boolean; message: string };

function redact(msg: string): string {
  let out = msg;
  for (const key of SECRET_KEYS) {
    const val = getSetting(key);
    if (val && val.length >= 4) out = out.split(val).join("***");
  }
  return out.slice(0, 240);
}

function runCmd(
  bin: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, PYTHONPATH: PYTHON_APP, WB_DATA_DIR: storeDir() },
      },
      (err, stdout, stderr) => {
        const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolvePromise({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
    child.on("error", (err) => {
      resolvePromise({ code: 1, stdout: "", stderr: err.message });
    });
  });
}

function which(cmd: string): string | null {
  try {
    const bin = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(bin, [cmd], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

async function probeFeishu(): Promise<ProbeResult> {
  const id = "feishu";
  const appId = getSetting("FEISHU_APP_ID");
  const secret = getSetting("FEISHU_APP_SECRET");
  if (!appId || !secret) return { id, ok: false, message: "还没填 App ID 或 Secret" };
  try {
    const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: secret }),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json()) as { code?: number; msg?: string };
    if (json.code === 0) return { id, ok: true, message: "应用凭证有效" };
    return { id, ok: false, message: redact(json.msg || `飞书返回 ${json.code ?? res.status}`) };
  } catch (err) {
    return { id, ok: false, message: redact(err instanceof Error ? err.message : "连不上飞书") };
  }
}

async function probeWorker(target: "python" | "baidu"): Promise<ProbeResult> {
  const bin = pythonBin();
  const r = await runCmd(bin, ["-m", "app.cli", "probe", "--target", target], 25_000);
  const raw = (r.stdout || r.stderr || "").trim();
  let msg = raw;
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string; executable?: string };
    if (parsed.ok) {
      return {
        id: target,
        ok: true,
        message: target === "python" ? `可用 ${parsed.executable || bin}` : "能拿到 token",
      };
    }
    if (parsed.error) msg = parsed.error;
  } catch {
    /* 非 JSON */
  }
  if (r.code === 0) return { id: target, ok: true, message: "通过" };
  return { id: target, ok: false, message: redact(msg || `${target} 探测失败`) };
}

async function probeBlender(): Promise<ProbeResult> {
  const id = "blender";
  const p = blenderBin();
  if (!p) return { id, ok: false, message: "还没填 Blender 路径" };
  if (!existsSync(p)) return { id, ok: false, message: "这个路径不存在" };
  const r = await runCmd(p, ["--version"], 15_000);
  const line = (r.stdout || r.stderr || "").split(/\r?\n/)[0] || "";
  if (r.code === 0 && /blender/i.test(line)) return { id, ok: true, message: line.slice(0, 80) };
  if (r.code === 0) return { id, ok: true, message: "能启动" };
  return { id, ok: false, message: redact(line || "启动失败") };
}

function probeLark(): ProbeResult {
  const id = "lark";
  const bin = which("lark-cli");
  if (!bin) return { id, ok: false, message: "本机找不到 lark-cli" };
  const enabled = /^(1|true|yes|on)$/i.test(getSetting("FEISHU_ENABLED"));
  const oid = getSetting("FEISHU_OPEN_ID");
  if (!enabled) return { id, ok: true, message: `已安装，推送未开（${bin}）` };
  if (!oid) return { id, ok: false, message: "已安装，但还没填推送对象" };
  return { id, ok: true, message: `已安装，将推给 ${oid.slice(0, 8)}…` };
}

export async function runProbe(id: string): Promise<ProbeResult> {
  switch (id) {
    case "feishu":
      return probeFeishu();
    case "baidu":
      return probeWorker("baidu");
    case "python":
      return probeWorker("python");
    case "blender":
      return probeBlender();
    case "lark":
      return probeLark();
    default:
      return { id, ok: false, message: "未知探测" };
  }
}

applyToEnv();
