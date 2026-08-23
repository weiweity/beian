/** WaitCard 文案。百分比禁止；queued 不准写 40 秒。 */

export type WaitKind = "compare" | "rework" | "mockup";

export type WaitCardTask = {
  status?: string;
  job_status?: string;
};

export type WaitCardCopyOpts = {
  kind: WaitKind;
  job_status?: string;
  job_stage_label?: string;
  job_eta_s?: number;
  queue_ahead?: number;
  feishuReady?: boolean;
};

const TITLE: Record<WaitKind, string> = {
  compare: "对照中",
  rework: "对红中",
  mockup: "打样中",
};

function queueLine(queue_ahead?: number): string {
  const n = Number(queue_ahead);
  const ahead = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return ahead > 0 ? `前面还有 ${ahead} 单` : "就快轮到";
}

function leaveHint(kind: WaitKind, feishuReady?: boolean): string {
  if (feishuReady) return "可以离开，完了飞书叫你";
  return kind === "mockup" ? "打样完回本页" : "对照完回看板";
}

/** Figma 等待卡 68:1218 正文。不要假取消。 */
function figmaWaitBody(kind: WaitKind): string {
  if (kind === "mockup") return "本机 Blender。白底不要带尺寸标注再交备案。";
  return "读表 + OCR 包装。机审只标疑点，不会自动过审。";
}

function formatEta(etaS: number): string {
  const s = Math.max(0, Math.floor(Number(etaS) || 0));
  if (s >= 60) {
    const minutes = Math.max(1, Math.round(s / 60));
    return `大约还要 ${minutes} 分钟`;
  }
  return `大约还要 ${s} 秒`;
}

/** 作业还在 queued|running 才等。status 仍是 comparing 但 job 已失败，直接进核对页。 */
export function shouldShowWaitCard(t: WaitCardTask | null): boolean {
  if (!t) return false;
  if (t.job_status === "failed" || t.job_status === "succeeded") return false;
  if (
    t.status === "compare_failed" ||
    t.status === "failed" ||
    t.status === "done" ||
    t.status === "completed"
  ) {
    return false;
  }
  if (t.job_status === "queued" || t.job_status === "running") return true;
  return t.status === "comparing";
}

export function waitCardCopy(opts: WaitCardCopyOpts): { title: string; eta: string; hint: string } {
  const title = TITLE[opts.kind];
  const leave = leaveHint(opts.kind, opts.feishuReady);
  if (opts.job_status === "queued") {
    const q = queueLine(opts.queue_ahead);
    return { title, eta: q, hint: `${q}。${leave}` };
  }
  const fallback = opts.kind === "mockup" ? 240 : 40;
  const etaS = opts.job_eta_s || fallback;
  const eta = formatEta(etaS);
  const stage = (opts.job_stage_label || "").trim();
  const body = stage || figmaWaitBody(opts.kind);
  const hint = opts.feishuReady ? `${body} ${leave}` : body;
  return { title, eta, hint };
}

/** GET /api/health 有 feishu_notify 才算能飞书叫人；没有字段就是 false。 */
export function feishuReadyFromHealth(body: { feishu_notify?: boolean } | null | undefined): boolean {
  return body?.feishu_notify === true;
}
