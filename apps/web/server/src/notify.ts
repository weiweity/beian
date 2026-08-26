import { spawn } from "node:child_process";
import { whichLark } from "./larkBin.js";
import { httpsJson } from "./outbound.js";
import { getSetting, publicBase } from "./settings.js";

type TaskLike = {
  id?: string;
  title?: string;
  conclusion?: string;
  complete_kind?: string;
  hits?: Array<{ field?: string; status?: string; decision?: string }>;
};

function clipText(text: string): string {
  return text.length <= 3500 ? text : `${text.slice(0, 3400)}\n…(截断)`;
}

function feishuErr(json: unknown): string {
  const o = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const err = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : {};
  const msg = String(err.message || o.msg || o.message || "").trim();
  const code = err.code ?? o.code;
  if (/scope|99991679|99991663/i.test(`${code} ${msg}`)) {
    return "飞书应用还没开通发消息权限。去开放平台给这应用加 IM，再让对方先跟机器人说过一句话。";
  }
  return msg ? `飞书返回：${msg}`.slice(0, 200) : "用飞书应用发消息失败";
}

async function sendViaApp(
  openId: string,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  const appId = getSetting("FEISHU_APP_ID").trim();
  const secret = getSetting("FEISHU_APP_SECRET").trim();
  if (!appId || !secret) return { ok: false, reason: "还没填飞书 App ID 或 Secret" };
  let token = "";
  try {
    const tok = await httpsJson("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: secret }),
    });
    const body = (tok.json || {}) as { code?: number; tenant_access_token?: string; msg?: string };
    if (body.code !== 0 || !body.tenant_access_token) {
      return { ok: false, reason: feishuErr(tok.json) };
    }
    token = body.tenant_access_token;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "连不上飞书拿 token" };
  }
  try {
    const sent = await httpsJson("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
      timeoutMs: 20_000,
    });
    const body = (sent.json || {}) as { code?: number; msg?: string };
    if (sent.status >= 200 && sent.status < 300 && (body.code === 0 || body.code === undefined)) {
      return { ok: true };
    }
    return { ok: false, reason: feishuErr(sent.json) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "连不上飞书发消息" };
  }
}

function sendViaCli(
  bin: string,
  openId: string,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  const asWho = getSetting("FEISHU_AS") || "bot";
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ["im", "+messages-send", "--as", asWho, "--user-id", openId, "--text", text, "--json"],
      {
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
        timeout: 45_000,
      },
    );
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.on("error", (err) => resolve({ ok: false, reason: err.message }));
    child.on("close", (code) => {
      if (code === 0) {
        try {
          const payload = JSON.parse(stdout) as { ok?: boolean };
          if (payload.ok === false) {
            resolve({ ok: false, reason: "lark-cli 返回失败" });
            return;
          }
        } catch {
          /* 非 JSON 也算发出去了 */
        }
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, reason: `lark-cli exit ${code}` });
    });
  });
}

export type TextSendOptions = { force?: boolean };

export type NotifyTransports = {
  findCli: () => string | null;
  sendCli: typeof sendViaCli;
  sendApp: typeof sendViaApp;
};

/**
 * 传输选择是一条深边界：生产接真实 CLI/飞书，L0 注入假传输，避免测试环境
 * 恰好装了 lark-cli 或带凭证时把合成消息发出去。
 */
export function createTextSender(transports: NotifyTransports) {
  return async function sendTextWithTransports(
    text: string,
    to?: string,
    opts: TextSendOptions = {},
  ): Promise<{ ok: boolean; skipped?: boolean; reason?: string; via?: "cli" | "app" }> {
    if (!opts.force && !/^(1|true|yes|on)$/i.test(getSetting("FEISHU_ENABLED"))) {
      return { ok: false, skipped: true, reason: "FEISHU_ENABLED=false" };
    }
    const openId = (to || getSetting("FEISHU_OPEN_ID") || "").trim();
    if (!openId) return { ok: false, skipped: true, reason: "missing FEISHU_OPEN_ID" };
    const body = clipText(text);
    const bin = transports.findCli();
    if (bin) {
      const cli = await transports.sendCli(bin, openId, body);
      if (cli.ok) return { ok: true, via: "cli" };
      const app = await transports.sendApp(openId, body);
      if (app.ok) return { ok: true, via: "app" };
      return { ok: false, reason: cli.reason || app.reason };
    }
    const app = await transports.sendApp(openId, body);
    if (app.ok) return { ok: true, via: "app" };
    return { ok: false, reason: app.reason || "本机没有 lark-cli，用飞书应用发也失败了" };
  };
}

const productionTextSender = createTextSender({
  findCli: whichLark,
  sendCli: sendViaCli,
  sendApp: sendViaApp,
});

export function sendText(
  text: string,
  to?: string,
  opts: TextSendOptions = {},
): Promise<{ ok: boolean; skipped?: boolean; reason?: string; via?: "cli" | "app" }> {
  // 所有 L0 都共享这条生产出口；在这里失败关闭，避免任一 HTTP 测试因本机
  // 恰好存在飞书配置而把合成审核消息发给真人。
  if (process.env.VITEST === "1") {
    return Promise.resolve({ ok: false, skipped: true, reason: "test notifications disabled" });
  }
  return productionTextSender(text, to, opts);
}

export async function notifyTaskComplete(task: TaskLike, actor: string): Promise<void> {
  const issues = (task.hits || []).filter((h) => h.decision === "issue");
  const headline = task.complete_kind === "rework" || issues.length ? "待设计改稿" : "已签字";
  const lines = issues.slice(0, 12).map((h) => `· ${h.field || "字段"}`);
  const more = issues.length > 12 ? `\n…另有 ${issues.length - 12} 条` : "";
  const text = [
    `【备案审核】${headline}`,
    `任务：${task.title || task.id || ""}`,
    `审核人：${actor}`,
    `结论：${task.conclusion || "—"}`,
    issues.length ? `改稿 ${issues.length} 条` : "无改稿项",
    ...lines,
    more,
    `打开：${publicBase()}/`,
  ]
    .filter(Boolean)
    .join("\n");
  const r = await sendText(text);
  if (!r.ok && !r.skipped) {
    console.warn("feishu notify skipped:", r.reason);
  }
}

export function jobOpenPath(kind: "compare" | "rework" | "mockup", tid: string): string {
  return kind === "mockup" ? `/mockup/${tid}` : `/review/${tid}`;
}

export async function notifyJobFinished(opts: {
  tid: string;
  title: string;
  kind: "compare" | "rework" | "mockup";
  ok: boolean;
  error?: string;
}): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  const verb = opts.kind === "mockup" ? "打样" : opts.kind === "rework" ? "对红" : "对照";
  const name = opts.title || opts.tid;
  const link = `${publicBase()}${jobOpenPath(opts.kind, opts.tid)}`;
  const text = opts.ok
    ? opts.kind === "mockup"
      ? `${name} 打样完了，来看产物。\n打开：${link}`
      : `${name} ${verb}完了，来签字。\n打开：${link}`
    : `${name} ${verb}失败：${opts.error || "对照中断"}\n打开：${link}`;
  return sendText(text);
}
