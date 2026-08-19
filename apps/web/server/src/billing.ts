import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { bceJson } from "./bce.js";
import { getSetting } from "./settings.js";

export const LEDGER_WINDOW = 300;
export const BILL_PAGE_SIZE = 50;
export const BILL_MAX_PAGES = 20;
const CACHE_MS = 5 * 60 * 1000;

export type ChargeStatus = "unknown";

export type LedgerEvent = {
  at: string;
  vendor: "baidu" | "minimax" | "other";
  kind: string;
  units: number;
  task_id?: string;
  actor?: string;
  note?: string;
  charge_status?: ChargeStatus;
  attempt?: "ok" | "failed";
  meta?: Record<string, unknown>;
};

export type BillRow = {
  month?: string;
  service?: string;
  product?: string;
  cash?: number;
  origin?: number;
  amount?: string;
  unit?: string;
};

export type MinimaxRemains = {
  remains_time?: number;
  usage_percent?: number;
  model_count?: number;
  window_start?: string;
  window_end?: string;
};

export type VendorBill = {
  vendor: string;
  label: string;
  ok: boolean;
  status: "ok" | "fail" | "partial" | "skip";
  message: string;
  balance?: number | string;
  balance_ok?: boolean;
  bills_ok?: boolean;
  bills_truncated?: boolean;
  bills_total?: number;
  fetched_at?: string;
  remains?: MinimaxRemains;
  bills: BillRow[];
};

type BceOpts = Parameters<typeof bceJson>[0];
type BceResult<T> = { ok: boolean; status: number; data: T | null; error: string };
type BceFn = <T>(opts: BceOpts) => Promise<BceResult<T>>;
type FetchFn = typeof fetch;

type Hooks = {
  bceJson?: BceFn;
  fetch?: FetchFn;
  now?: () => Date;
  writeLedger?: (line: string) => void;
};

let hooks: Hooks = {};

export function setBillingHooksForTest(next: Hooks): void {
  hooks = next;
}

export function resetBillingHooksForTest(): void {
  hooks = {};
}

function nowDate(): Date {
  return hooks.now ? hooks.now() : new Date();
}

function callBce<T>(opts: BceOpts): Promise<BceResult<T>> {
  return (hooks.bceJson || bceJson)<T>(opts);
}

function callFetch(url: string, init: RequestInit): Promise<Response> {
  return (hooks.fetch || fetch)(url, init);
}

function ledgerPath() {
  mkdirSync(DATA_DIR, { recursive: true });
  return join(DATA_DIR, "billing-ledger.jsonl");
}

export function recordUsage(ev: Omit<LedgerEvent, "at"> & { at?: string }): void {
  const row: LedgerEvent = { ...ev, at: ev.at || nowDate().toISOString() };
  const line = JSON.stringify(row) + "\n";
  if (hooks.writeLedger) {
    hooks.writeLedger(line);
    return;
  }
  appendFileSync(ledgerPath(), line, { encoding: "utf8", mode: 0o600 });
}

/** 台账写失败不得抛到审稿主链路。 */
export function recordCompareAttempt(ev: {
  task_id: string;
  actor?: string;
  note?: string;
  attempt: "ok" | "failed";
}): { recorded: boolean } {
  try {
    recordUsage({
      vendor: "baidu",
      kind: "ocr_job",
      units: 1,
      task_id: ev.task_id,
      actor: ev.actor,
      note: ev.note,
      charge_status: "unknown",
      attempt: ev.attempt,
    });
    return { recorded: true };
  } catch {
    return { recorded: false };
  }
}

/** 对照结果以 worker 为准；台账只是旁路。 */
export function compareBookkeeping(
  compareOk: boolean,
  ev: { task_id: string; actor?: string; note?: string },
): { compare_ok: boolean; recorded: boolean } {
  const recorded = recordCompareAttempt({
    ...ev,
    attempt: compareOk ? "ok" : "failed",
  }).recorded;
  return { compare_ok: compareOk, recorded };
}

export function readLedger(limit = 200): LedgerEvent[] {
  const p = ledgerPath();
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  const out: LedgerEvent[] = [];
  for (const line of lines.slice(-Math.max(limit, 1))) {
    try {
      out.push(JSON.parse(line) as LedgerEvent);
    } catch {
      /* skip */
    }
  }
  return out.reverse();
}

export function ledgerTotals(events: LedgerEvent[]): Record<string, { count: number; units: number }> {
  const acc: Record<string, { count: number; units: number }> = {};
  for (const e of events) {
    const key = `${e.vendor}:${e.kind}`;
    const cur = acc[key] || { count: 0, units: 0 };
    cur.count += 1;
    cur.units += Number(e.units) || 0;
    acc[key] = cur;
  }
  return acc;
}

type Cache = { at: number; key: string; value: VendorBill[] };
let cache: Cache | null = null;
let inflight: Promise<VendorBill[]> | null = null;

function vendorCacheKey(): string {
  const ak = (getSetting("BAIDU_CLOUD_AK") || getSetting("BAIDU_OCR_API_KEY")).trim();
  const sk = (getSetting("BAIDU_CLOUD_SK") || getSetting("BAIDU_OCR_SECRET_KEY")).trim();
  const mk = getSetting("MINIMAX_API_KEY").trim();
  return `${ak.length}:${ak.slice(-4)}|${sk.length}:${sk.slice(-4)}|${mk.length}:${mk.slice(-4)}`;
}

export function shanghaiMonth(at: Date = nowDate()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(at);
  const y = parts.find((p) => p.type === "year")?.value || "0000";
  const m = parts.find((p) => p.type === "month")?.value || "01";
  return `${y}-${m}`;
}

function mapBillRow(
  month: string,
  b: {
    serviceTypeName?: string;
    serviceType?: string;
    productType?: string;
    cash?: number;
    originPrice?: number;
    amount?: string;
    amountUnit?: string;
    chargeItemDesc?: string;
  },
): BillRow {
  return {
    month,
    service: b.serviceTypeName || b.serviceType || "",
    product: b.chargeItemDesc || b.productType || "",
    cash: b.cash,
    origin: b.originPrice,
    amount: b.amount,
    unit: b.amountUnit,
  };
}

export function pickMinimaxRemains(data: unknown): MinimaxRemains {
  if (!data || typeof data !== "object") return {};
  const o = data as Record<string, unknown>;
  const out: MinimaxRemains = {};
  if (typeof o.remains_time === "number" && Number.isFinite(o.remains_time)) out.remains_time = o.remains_time;
  const pct = o.usage_percent ?? o.usagePercent;
  if (typeof pct === "number" && Number.isFinite(pct)) out.usage_percent = pct;
  if (Array.isArray(o.model_remains)) out.model_count = o.model_remains.length;
  if (typeof o.start_time === "string") out.window_start = o.start_time;
  if (typeof o.end_time === "string") out.window_end = o.end_time;
  return out;
}

function baiduStatus(balanceOk: boolean, billsOk: boolean): "ok" | "fail" | "partial" {
  if (balanceOk && billsOk) return "ok";
  if (!balanceOk && !billsOk) return "fail";
  return "partial";
}

type MonthBillPage = {
  billMonth?: string;
  totalCount?: number;
  bills?: Array<{
    serviceTypeName?: string;
    serviceType?: string;
    productType?: string;
    cash?: number;
    originPrice?: number;
    amount?: string;
    amountUnit?: string;
    chargeItemDesc?: string;
  }>;
  message?: string;
};

async function fetchBaiduMonthPages(
  ak: string,
  sk: string,
  month: string,
): Promise<{
  ok: boolean;
  error: string;
  rows: BillRow[];
  total?: number;
  truncated: boolean;
  billMonth: string;
}> {
  const host = "billing.baidubce.com";
  const rows: BillRow[] = [];
  let total: number | undefined;
  let billMonth = month;
  let lastError = "";
  for (let pageNo = 1; pageNo <= BILL_MAX_PAGES; pageNo++) {
    const bill = await callBce<MonthBillPage>({
      ak,
      sk,
      method: "GET",
      host,
      path: "/v1/bill/resource/month",
      query: { month, productType: "postpay", pageNo: String(pageNo), pageSize: String(BILL_PAGE_SIZE) },
    });
    if (!bill.ok) {
      lastError = bill.error || `HTTP ${bill.status}`;
      if (pageNo === 1) {
        return { ok: false, error: lastError, rows: [], total, truncated: false, billMonth };
      }
      return { ok: true, error: lastError, rows, total, truncated: true, billMonth };
    }
    const pageMonth = bill.data?.billMonth || month;
    billMonth = pageMonth;
    if (typeof bill.data?.totalCount === "number") total = bill.data.totalCount;
    const chunk = bill.data?.bills || [];
    for (const b of chunk) rows.push(mapBillRow(pageMonth, b));
    const gotAll = typeof total === "number" && rows.length >= total;
    const lastPageShort = chunk.length < BILL_PAGE_SIZE;
    if (gotAll || lastPageShort) {
      return { ok: true, error: "", rows, total, truncated: false, billMonth };
    }
  }
  const truncated = typeof total === "number" ? rows.length < total : true;
  return { ok: true, error: "", rows, total, truncated, billMonth };
}

async function baiduBills(): Promise<VendorBill> {
  const ak = getSetting("BAIDU_CLOUD_AK") || getSetting("BAIDU_OCR_API_KEY");
  const sk = getSetting("BAIDU_CLOUD_SK") || getSetting("BAIDU_OCR_SECRET_KEY");
  const fetched_at = nowDate().toISOString();
  if (!ak || !sk) {
    return {
      vendor: "baidu",
      label: "百度智能云",
      ok: false,
      status: "fail",
      message: "还没填百度账单 AK/SK（可与 OCR Key 分开填）",
      balance_ok: false,
      bills_ok: false,
      fetched_at,
      bills: [],
    };
  }
  const host = "billing.baidubce.com";
  const month = shanghaiMonth();
  const bal = await callBce<{ cashBalance?: number }>({
    ak,
    sk,
    method: "POST",
    host,
    path: "/v1/finance/cash/balance",
    body: "{}",
  });
  const monthBill = await fetchBaiduMonthPages(ak, sk, month);
  const balance_ok = bal.ok;
  const bills_ok = monthBill.ok && !monthBill.truncated;
  const status = baiduStatus(balance_ok, monthBill.ok);
  const bits: string[] = [];
  bits.push(balance_ok ? `现金余额 ${bal.data?.cashBalance ?? "—"} 元` : `余额未取到：${bal.error}`);
  if (!monthBill.ok) bits.push(`月账单失败：${monthBill.error}`);
  else if (monthBill.truncated) bits.push(`月账单已取 ${monthBill.rows.length} 条，未取全`);
  else bits.push(`月账单 ${monthBill.rows.length} 条`);
  return {
    vendor: "baidu",
    label: "百度智能云",
    ok: status === "ok" && bills_ok,
    status: monthBill.ok && monthBill.truncated && balance_ok ? "partial" : status,
    message: bits.join("。"),
    balance: bal.data?.cashBalance,
    balance_ok,
    bills_ok: monthBill.ok,
    bills_truncated: monthBill.truncated,
    bills_total: monthBill.total ?? monthBill.rows.length,
    fetched_at,
    bills: monthBill.rows,
  };
}

async function minimaxBills(): Promise<VendorBill> {
  const key = getSetting("MINIMAX_API_KEY");
  const fetched_at = nowDate().toISOString();
  if (!key) {
    return {
      vendor: "minimax",
      label: "MiniMax",
      ok: false,
      status: "fail",
      message: "还没填 MiniMax Key（可选）。余量不是账单。",
      fetched_at,
      bills: [],
    };
  }
  const urls = [
    "https://api.minimaxi.com/v1/token_plan/remains",
    "https://www.minimax.io/v1/token_plan/remains",
    "https://api.minimax.io/v1/token_plan/remains",
  ];
  let last = "连不上 MiniMax 余量接口";
  for (const url of urls) {
    try {
      const res = await callFetch(url, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      let data: unknown = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {};
      }
      if (res.ok) {
        const remains = pickMinimaxRemains(data);
        const has = Object.keys(remains).length > 0;
        return {
          vendor: "minimax",
          label: "MiniMax",
          ok: true,
          status: "ok",
          message: has
            ? "已取到订阅余量。余量不是账单，也不是发票。"
            : "余量接口通了，但没有可识别的余量字段。余量不是账单。",
          remains,
          fetched_at,
          bills: [],
        };
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : last;
    }
  }
  return {
    vendor: "minimax",
    label: "MiniMax",
    ok: false,
    status: "fail",
    message: `官方余量接口不可用：${last}。余量不是账单。`,
    fetched_at,
    bills: [],
  };
}

async function fetchAllVendors(): Promise<VendorBill[]> {
  const [baidu, minimax] = await Promise.all([baiduBills(), minimaxBills()]);
  const feishu: VendorBill = {
    vendor: "feishu",
    label: "飞书开放平台",
    ok: true,
    status: "skip",
    message: "企业自建应用调身份/发消息，不按次向本台收钱。没有可拉的审稿账单。",
    fetched_at: nowDate().toISOString(),
    bills: [],
  };
  return [baidu, minimax, feishu];
}

export async function loadVendorBills(force = false): Promise<VendorBill[]> {
  const key = vendorCacheKey();
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inflight) return inflight;
  const pending = fetchAllVendors().then((value) => {
    cache = { at: Date.now(), key, value };
    return value;
  });
  inflight = pending;
  try {
    return await pending;
  } finally {
    if (inflight === pending) inflight = null;
  }
}

export function billingSnapshot() {
  const events = readLedger(LEDGER_WINDOW);
  return {
    vendors: cache?.value || [],
    cached_at: cache?.at ? new Date(cache.at).toISOString() : null,
    ledger: events,
    ledger_window: LEDGER_WINDOW,
    ledger_label: `本机任务调用记录（最近 ${LEDGER_WINDOW} 条）`,
    totals: ledgerTotals(events),
  };
}

export function resetBillingCache(): void {
  cache = null;
  inflight = null;
}

export function writeLedgerForTest(events: LedgerEvent[]): void {
  writeFileSync(ledgerPath(), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
}
