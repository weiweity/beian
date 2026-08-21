import { execFileSync, spawn } from "node:child_process";
import { getSetting, publicBase } from "./settings.js";

type TaskLike = {
  id?: string;
  title?: string;
  conclusion?: string;
  complete_kind?: string;
  hits?: Array<{ field?: string; status?: string; decision?: string }>;
};

function whichLark(): string | null {
  const names = process.platform === "win32" ? ["lark-cli.cmd", "lark-cli.exe", "lark-cli"] : ["lark-cli"];
  const finder = process.platform === "win32" ? "where" : "which";
  for (const name of names) {
    try {
      const out = execFileSync(finder, [name], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
      if (out) return out;
    } catch {
      /* next */
    }
  }
  return null;
}

export function sendText(text: string): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  if (!/^(1|true|yes|on)$/i.test(getSetting("FEISHU_ENABLED"))) {
    return Promise.resolve({ ok: false, skipped: true, reason: "FEISHU_ENABLED=false" });
  }
  const openId = getSetting("FEISHU_OPEN_ID");
  if (!openId) return Promise.resolve({ ok: false, skipped: true, reason: "missing FEISHU_OPEN_ID" });
  const bin = whichLark();
  if (!bin) return Promise.resolve({ ok: false, reason: "lark-cli not found" });
  const asWho = getSetting("FEISHU_AS") || "bot";
  const body = text.length <= 3500 ? text : `${text.slice(0, 3400)}\n…(截断)`;
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ["im", "+messages-send", "--as", asWho, "--user-id", openId, "--text", body, "--json"],
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

export async function notifyJobFinished(opts: {
  tid: string;
  title: string;
  kind: "compare" | "rework" | "mockup";
  ok: boolean;
  error?: string;
}): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  const verb = opts.kind === "mockup" ? "打样" : opts.kind === "rework" ? "对红" : "对照";
  const name = opts.title || opts.tid;
  const link = `${publicBase()}/?task=${opts.tid}`;
  const text = opts.ok
    ? opts.kind === "mockup"
      ? `${name} 打样完了，来看产物。\n打开：${link}`
      : `${name} ${verb}完了，来签字。\n打开：${link}`
    : `${name} ${verb}失败：${opts.error || "对照中断"}\n打开：${link}`;
  return sendText(text);
}
