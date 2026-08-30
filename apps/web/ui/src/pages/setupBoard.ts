import type { ProbeResult } from "../api";

export const SETUP_RETURN = "wb_setup_return_probe";
export const SETUP_NEXT = "/settings?group=" + encodeURIComponent("开工板");

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
  飞书推送: {
    intro: "点发一条测试。不必装 lark-cli，也不必手填开关、open_id、bot。发给当前登录的飞书。",
    steps: [
      "没有飞书身份时，按钮会直接带你去飞书授权。授权回来再点一次。",
      "点发一条测试。用已填的飞书应用发给当前登录。成功会自动打开推送并记下你的 open_id。",
      "手机飞书应收到「审稿台推送测试」。没有则去开放平台给应用开通发消息，并先跟这个机器人说过一句话。",
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
  "这是杭州 Windows 上的 exe，不是云账号。只有显式授权的管理员能扫、能采用。扫到路径要点采用才写入。找不到就人话列出搜过的目录和 PATH。";

export const PUSH_INTRO =
  "点发一条测试即可。不必装 lark-cli，不必手填开关、open_id、bot。开工板绿不等于籽烨已收到；她作为审稿接收人可在本页再测一次。";

export function settingsGroupPath(group: string): string {
  return "/settings?group=" + encodeURIComponent(group);
}

export function feishuLoginHref(nextGroup = "开工板"): string {
  return `/api/auth/feishu/login?next=${encodeURIComponent(settingsGroupPath(nextGroup))}`;
}

export function feishuAppReady(
  groups: { fields: { key: string; set: boolean }[] }[] | undefined,
): boolean {
  if (!groups) return false;
  const fields = groups.flatMap((g) => g.fields);
  return Boolean(fields.find((f) => f.key === "FEISHU_APP_ID")?.set && fields.find((f) => f.key === "FEISHU_APP_SECRET")?.set);
}

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

export function statusWord(
  r: ProbeResult | { pending: true } | undefined,
  mode?: "send",
): { cls: string; text: string } {
  if (!r) return { cls: "is-idle", text: "未测" };
  if ("pending" in r) return { cls: "is-wait", text: mode === "send" ? "发送中" : "检测中" };
  if (r.ok && /未启用/.test(r.message)) return { cls: "is-ok", text: "未用" };
  if (r.ok) return { cls: "is-ok", text: "可用" };
  if (/超时/.test(r.message)) return { cls: "is-wait", text: "超时" };
  return { cls: "is-bad", text: "还缺" };
}

export function isPending(r: ProbeResult | { pending: true } | undefined): r is { pending: true } {
  return Boolean(r && "pending" in r);
}

export function rowDetail(
  row: (typeof BOARD_ROWS)[number],
  r: ProbeResult | { pending: true } | undefined,
  who: string,
  sending = false,
): string {
  if (sending && row.kind === "push") return "正在发给当前登录的飞书，请稍等。";
  if (isPending(r)) {
    if (row.kind === "scan") return "正在扫这台电脑…";
    return "正在检测，请稍等。";
  }
  if (r) {
    if (row.id === "lark" && r.ok) return `能发给当前登录 · ${who}`;
    return r.message;
  }
  return idleRowMessage(row.id, row.kind);
}

export function foldCatalogReason(
  group: string,
  fields: { key: string; set: boolean; last4: string; value: string }[],
  probe?: ProbeResult | { pending: true },
): string | null {
  const probeOk = Boolean(probe && !("pending" in probe) && probe.ok);
  if (group === "飞书推送") {
    return "接收人和发送身份由「发一条测试」自动写入。点开才改。";
  }
  if (group === "百度 OCR") {
    const ak = fields.find((f) => f.key === "BAIDU_OCR_API_KEY");
    if (ak?.set || probeOk) {
      return `对照识别已可用${ak?.last4 ? `（Key ${ak.last4}）` : ""}。密钥默认收起。`;
    }
  }
  if (group === "MiniMax（可选）") {
    const enabled = fields.find((f) => f.key === "MINIMAX_ENABLED");
    const key = fields.find((f) => f.key === "MINIMAX_API_KEY");
    if (enabled?.value === "false" || (probe && !("pending" in probe) && /未启用/.test(probe.message))) {
      return "语义复核未开，不影响主对照。密钥默认收起。";
    }
    if (key?.set || probeOk) {
      return `模型列表已测通${key?.last4 ? `（Key ${key.last4}）` : ""}。密钥默认收起。`;
    }
  }
  return null;
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
  if (kind === "scan") return "路径还没确认。请由管理员点扫描，再点采用。";
  if (kind === "push") return "点发一条测试。没有飞书身份会先带你去授权，不必手填 open_id。";
  return "点全部检测或这一行";
}

export function probeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : "探测失败";
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return "服务没连上。看杭州 :8787 还在不在。";
  }
  return raw;
}
