import type { ProbeResult } from "../api";

export const SETUP_RETURN = "wb_setup_return_probe";
export const SETUP_NEXT = "/?tab=settings&group=" + encodeURIComponent("开工板");

export const PROBE_BY_GROUP: Record<string, string[]> = {
  开工板: ["feishu", "lark", "baidu", "minimax", "python", "blender", "illustrator"],
  飞书登录: ["feishu"],
  飞书推送: ["lark"],
  "百度 OCR": ["baidu"],
  "MiniMax（可选）": ["minimax"],
  本机依赖: ["python", "blender", "illustrator"],
};

export const VIRTUAL = new Set(["外观", "开工板", "费用账单"]);

export const BOARD_ROWS: {
  id: string;
  title: string;
  group: string;
  kind: "wizard" | "push" | "scan" | "retry";
}[] = [
  { id: "feishu", title: "飞书登录", group: "飞书登录", kind: "wizard" },
  { id: "lark", title: "飞书推送", group: "飞书推送", kind: "push" },
  { id: "baidu", title: "百度 OCR", group: "百度 OCR", kind: "wizard" },
  { id: "minimax", title: "MiniMax", group: "MiniMax（可选）", kind: "wizard" },
  { id: "python", title: "Python", group: "本机依赖", kind: "retry" },
  { id: "blender", title: "Blender", group: "本机依赖", kind: "scan" },
  { id: "illustrator", title: "Illustrator", group: "本机依赖", kind: "scan" },
];

export type WizardGuide = {
  intro: string;
  steps: string[];
};

export const WIZARD: Record<string, WizardGuide> = {
  飞书登录: {
    intro: "网页应用走完 OAuth 才算绿。不是第二套登录，籽烨日常进站不走这页。",
    steps: [
      "开放平台建网页应用，复制 App ID / App Secret。",
      "回调地址填对外网址 + /api/auth/feishu/callback。",
      "保存后点「用飞书走一遍授权」，或回开工板复测这一行。",
    ],
  },
  "百度 OCR": {
    intro: "做不到静默授权。绿的意思是对照真正会调用的识别接口通了。",
    steps: [
      "打开百度智能云文字识别控制台。",
      "建应用，复制 API Key 和 Secret。",
      "粘贴到下面保存。开工板会用对照同款接口复测，没有静默授权。",
    ],
  },
  "MiniMax（可选）": {
    intro: "探测是 GET /v1/models 模型列表，不是对话，也不是余额。",
    steps: [
      "粘贴国内能用的 API Key。",
      "模型只留国内可用项，默认 MiniMax-M3，不要铺全球模型。",
      "保存后回开工板复测。通了必须看见「模型列表」，不能只写一个「通」。",
    ],
  },
};

export const HOST_INTRO =
  "这是杭州 Windows 上的 exe，不是云账号。只有管理员魏炜能扫、能采用。扫到路径要点采用才写入。找不到就人话列出搜过的目录和 PATH。";

export const PUSH_INTRO =
  "「发一条测试」发给当前登录。不必先装 lark-cli：已填的飞书应用凭证可以直接发。籽烨作为审稿接收人，只在这一页单独测。开工板绿不等于她已收到。";

export function shortGroupLabel(title: string): string {
  if (title === "费用账单") return "费用";
  if (title === "MiniMax（可选）") return "MiniMax";
  if (title === "本机依赖") return "本机";
  return title;
}

export function setupHeadline(probes: Record<string, ProbeResult | { pending: true }>): string {
  const rows = BOARD_ROWS.map((row) => probes[row.id]);
  const done = rows.filter((r): r is ProbeResult => Boolean(r) && !("pending" in r));
  const ok = done.filter((r) => r.ok).length;
  if (done.length === 0) return "还没测过。先点全部检测。";
  if (ok === BOARD_ROWS.length) return "七条探测通过。不是对照已跑通，也不是 8/31 验收。";
  const firstBad = firstBadRow(probes);
  return `杭州这台机还缺 ${BOARD_ROWS.length - ok} 条。${firstBad ? `下一步：${firstBad.title}` : "红的右边有下一步。"}`;
}

export function firstBadRow(probes: Record<string, ProbeResult | { pending: true }>) {
  return BOARD_ROWS.find((row) => {
    const r = probes[row.id];
    return r && !("pending" in r) && !r.ok;
  });
}

export function statusWord(r: ProbeResult | { pending: true } | undefined): { cls: string; text: string } {
  if (!r) return { cls: "is-idle", text: "未测" };
  if ("pending" in r) return { cls: "is-wait", text: "检测中" };
  if (r.ok) return { cls: "is-ok", text: "可用" };
  if (/超时/.test(r.message)) return { cls: "is-wait", text: "超时" };
  return { cls: "is-bad", text: "还缺" };
}

export function progressSpoken(probes: Record<string, ProbeResult | { pending: true }>, probeBusy: string): string {
  if (probeBusy) return probeBusy.replace("检测中 ", "检测中 ");
  const done = BOARD_ROWS.map((row) => probes[row.id]).filter(
    (r): r is ProbeResult => Boolean(r) && !("pending" in r),
  );
  const ok = done.filter((r) => r.ok).length;
  if (done.length === 0) return `0 分之 ${BOARD_ROWS.length} 未测，先点全部检测`;
  const firstBad = firstBadRow(probes);
  if (ok === BOARD_ROWS.length) return `${BOARD_ROWS.length} 分之 ${BOARD_ROWS.length} 可用，七条探测通过`;
  if (firstBad) return `${ok} 分之 ${BOARD_ROWS.length} 可用，下一步 ${firstBad.title}`;
  return `${ok} 分之 ${BOARD_ROWS.length} 可用`;
}

export function idleRowMessage(id: string, kind: (typeof BOARD_ROWS)[number]["kind"]): string {
  if (id === "minimax") return "模型列表 GET /v1/models，不是对话";
  if (kind === "scan") return "路径还没确认。管理员魏炜点扫描，再点采用。";
  if (kind === "push") return "点发一条测试，用飞书应用发给当前登录";
  return "点全部检测或这一行";
}

export function probeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : "探测失败";
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return "服务没连上。看杭州 :8787 还在不在。";
  }
  return raw;
}
