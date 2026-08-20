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

/** job_status 为 queued|running，或看板 status 仍是 comparing。 */
export function shouldShowWaitCard(t: WaitCardTask | null): boolean {
  if (!t) return false;
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
  const eta = `大约还要 ${etaS} 秒`;
  const stage = (opts.job_stage_label || "").trim();
  const hint = stage ? `${stage}。${leave}` : leave;
  return { title, eta, hint };
}

/** GET /api/health 有 feishu_notify 才算能飞书叫人；没有字段就是 false。 */
export function feishuReadyFromHealth(body: { feishu_notify?: boolean } | null | undefined): boolean {
  return body?.feishu_notify === true;
}
