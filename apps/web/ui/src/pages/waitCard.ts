/** WaitCard 文案不画百分比；queued 不准写 40 秒。审稿台紧凑行的阶段百分比见文末。 */

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

/** 等待圆盘逐字，和 WaitCard 标题同一套：对照中 / 对红中 / 打样中。 */
export function waitLoaderLetters(kind: WaitKind): string[] {
  return Array.from(TITLE[kind]);
}

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

export type DetailLoadState = "error" | "loading" | "waiting" | "ready";

/** 详情页重验失败必须盖过创建接口留下的 queued 快照，不能让等待卡永久吞掉错误。 */
export function detailLoadState(t: WaitCardTask | null, error: string | null): DetailLoadState {
  if (error) return "error";
  if (!t) return "loading";
  return shouldShowWaitCard(t) ? "waiting" : "ready";
}

/** 看板/侧栏活进度。queued 不准写秒；没有作业返回 null。 */
export function liveJobLine(opts: {
  job_status?: string;
  job_stage_label?: string;
  job_eta_s?: number;
  queue_ahead?: number;
  kind?: WaitKind;
}): string | null {
  if (opts.job_status === "queued") return queueLine(opts.queue_ahead);
  if (opts.job_status !== "running") return null;
  const stage = (opts.job_stage_label || "").trim();
  if (typeof opts.job_eta_s === "number" && opts.job_eta_s > 0) {
    const eta = formatEta(opts.job_eta_s);
    return stage ? `${stage} · ${eta}` : eta;
  }
  if (stage) return stage;
  const fallback = opts.kind === "mockup" ? 240 : 40;
  return formatEta(fallback);
}

/**
 * 审稿台紧凑明细只显示一个阶段百分比。它表示机器流程走到哪一段，不伪装成
 * 字节级精确进度：排队 0%，出图 20%，认字 55%，对照 85%，完成后 100%。
 * 运行中但没有真实 STAGE 时不猜数字，回退“正在对照”。
 */
export function compareBoardProgress(opts: {
  status?: string;
  job_status?: string;
  job_stage?: string;
  job_stage_label?: string;
}): number | undefined {
  if (opts.job_status === "failed" || opts.status === "compare_failed") return undefined;
  const comparing = opts.status === "comparing" || opts.job_status === "queued" || opts.job_status === "running";
  if (!comparing) return undefined;
  if (opts.job_status === "succeeded") return 100;
  if (opts.job_status === "queued") return 0;
  const key = `${opts.job_stage || ""} ${opts.job_stage_label || ""}`.trim().toLowerCase();
  if (/(^|\s)(match|对照)(\s|$)/.test(key)) return 85;
  if (/(^|\s)(layout|分区)(\s|$)/.test(key)) return 70;
  if (/(^|\s)(ocr|认字)(\s|$)/.test(key)) return 55;
  if (/(^|\s)(ingest|识稿)(\s|$)/.test(key)) return 35;
  if (/(^|\s)(render_pdf|出图)(\s|$)/.test(key)) return 20;
  return undefined;
}

/** 打样台与审稿台共用同一种紧凑明细；这里只映射真实 worker 阶段。 */
export function mockupBoardProgress(opts: {
  status?: string;
  job_status?: string;
  job_stage?: string;
  job_stage_label?: string;
}): number | undefined {
  if (opts.status === "failed" || opts.status === "unsupported" || opts.job_status === "failed") {
    return undefined;
  }
  const running =
    opts.status === "queued" ||
    opts.status === "running" ||
    opts.job_status === "queued" ||
    opts.job_status === "running";
  if (!running) return undefined;
  if (opts.job_status === "queued") return 0;
  const key = `${opts.job_stage || ""} ${opts.job_stage_label || ""}`.trim().toLowerCase();
  if (/(^|\s)(export|导出)(\s|$)/.test(key)) return 90;
  if (/(^|\s)(blender|打样)(\s|$)/.test(key)) return 70;
  if (/(^|\s)(render_pdf|出图)(\s|$)/.test(key)) return 35;
  if (/(illustrator_|打开稿件|盘点图层|保存整页|保存印刷|写出结构|关闭文档)/.test(key)) return 15;
  if (/(^|\s)(illustrator|识别结构|正在出图|结构)(\s|$)/.test(key)) return 15;
  return undefined;
}

export function waitCardActiveSteps(
  kind: WaitKind,
  job_status?: string,
  stage?: string,
  stageLabel?: string,
): number {
  if (job_status === "queued") return 0;
  const key = (stage || "").trim() || (stageLabel || "").trim();
  if (kind === "mockup") {
    if (key === "export" || key === "导出") return 4;
    if (key === "blender" || key === "打样") return 3;
    if (key === "render_pdf" || key === "出图") return 1;
    return 2;
  }
  if (key === "match" || key === "对照") return 3;
  if (key === "layout" || key === "分区") return 2;
  if (key === "ocr" || key === "认字") return 2;
  if (key === "ingest" || key === "识稿") return 1;
  if (key === "render_pdf" || key === "出图") return 1;
  return 1;
}

export function pickLiveMockup<T extends { status?: string; job_status?: string; created_at?: string }>(
  rows: T[],
): T | null {
  const live = rows.filter((r) => {
    if (r.status === "done" || r.status === "failed") return false;
    return (
      r.status === "queued" ||
      r.status === "running" ||
      r.job_status === "queued" ||
      r.job_status === "running"
    );
  });
  if (!live.length) return null;
  return live.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
}

export function liveNavPulse(body: { jobs?: unknown } | null | undefined): {
  review: boolean;
  mockup: boolean;
} {
  const jobs = (body?.jobs || {}) as Record<string, { running?: number; queued?: number }>;
  const n = (k: string) => Number(jobs[k]?.running || 0) + Number(jobs[k]?.queued || 0);
  return { review: n("ocr") > 0, mockup: n("blender") + n("illustrator") > 0 };
}

export function waitCardCopy(opts: WaitCardCopyOpts): { title: string; eta: string; hint: string } {
  const title = TITLE[opts.kind];
  const leave = leaveHint(opts.kind, opts.feishuReady);
  if (opts.job_status === "queued") {
    const q = queueLine(opts.queue_ahead);
    return { title, eta: q, hint: `${q}。${leave}` };
  }
  const fallback = opts.kind === "mockup" ? 240 : 40;
  const stage = (opts.job_stage_label || "").trim();
  const eta =
    typeof opts.job_eta_s === "number" && opts.job_eta_s > 0
      ? formatEta(opts.job_eta_s)
      : stage || formatEta(fallback);
  const body = stage || figmaWaitBody(opts.kind);
  const hint = opts.feishuReady ? `${body} ${leave}` : body;
  return { title, eta, hint };
}

/** 鉴权状态接口有 feishu_notify 才算能飞书叫人；没有字段就是 false。 */
export function feishuReadyFromHealth(body: { feishu_notify?: boolean } | null | undefined): boolean {
  return body?.feishu_notify === true;
}
