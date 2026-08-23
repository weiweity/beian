import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-bill-"));

const { bceAuthorization } = await import("./bce.js");
const {
  BILL_PAGE_SIZE,
  LEDGER_WINDOW,
  billingSnapshot,
  compareBookkeeping,
  loadVendorBills,
  pickMinimaxRemains,
  readLedger,
  recordUsage,
  ledgerTotals,
  resetBillingCache,
  resetBillingHooksForTest,
  setBillingHooksForTest,
  shanghaiMonth,
} = await import("./billing.js");
const { boardColumn } = await import("./tasks.js");
const { computeHealth, saveSettings } = await import("./settings.js");

describe("board columns", () => {
  it("maps review and done", () => {
    assert.equal(boardColumn("pending_review"), "review");
    assert.equal(boardColumn("in_review"), "review");
    assert.equal(boardColumn("completed"), "done");
    assert.equal(boardColumn("comparing"), "comparing");
    assert.equal(boardColumn("compare_failed"), "failed");
    assert.equal(boardColumn("comparing", "failed"), "failed");
  });
});

describe("bce auth string", () => {
  it("has v1 prefix and signed host", () => {
    const auth = bceAuthorization({
      ak: "ak-test",
      sk: "sk-test",
      method: "POST",
      path: "/v1/finance/cash/balance",
      headers: { host: "billing.baidubce.com", "content-type": "application/json; charset=utf-8" },
      now: new Date("2019-04-06T06:34:40Z"),
    });
    assert.match(auth, /^bce-auth-v1\/ak-test\/2019-04-06T06:34:40Z\/1800\//);
    assert.match(auth, /host/);
  });
});

describe("local ledger", () => {
  it("appends and totals", () => {
    recordUsage({ vendor: "baidu", kind: "ocr_job", units: 1, task_id: "aaaaaaaaaaaa" });
    recordUsage({ vendor: "baidu", kind: "ocr_job", units: 1, task_id: "bbbbbbbbbbbb" });
    const ev = readLedger(10);
    assert.ok(ev.length >= 2);
    const tot = ledgerTotals(ev);
    assert.equal(tot["baidu:ocr_job"]?.count, 2);
  });
});

describe("health", () => {
  it("fails closed when keys missing", () => {
    const h = computeHealth();
    assert.equal(h.review.ok, false);
  });

  it("turns review green when baidu keys set", () => {
    saveSettings({ BAIDU_OCR_API_KEY: "akxxxx", BAIDU_OCR_SECRET_KEY: "skxxxx" });
    const h = computeHealth();
    assert.equal(h.review.ok, true);
  });
});

describe("compare bookkeeping", () => {
  it("usage-write failure does not flip a successful compare", () => {
    setBillingHooksForTest({
      writeLedger: () => {
        throw new Error("EACCES");
      },
    });
    const r = compareBookkeeping(true, { task_id: "aaaaaaaaaaaa", note: "x" });
    assert.equal(r.compare_ok, true);
    assert.equal(r.recorded, false);
    resetBillingHooksForTest();
  });

  it("failed attempts are unknown-charge not billed", () => {
    resetBillingHooksForTest();
    const r = compareBookkeeping(false, { task_id: "bbbbbbbbbbbb", note: "y" });
    assert.equal(r.compare_ok, false);
    assert.equal(r.recorded, true);
    const ev = readLedger(5).find((e) => e.task_id === "bbbbbbbbbbbb");
    assert.ok(ev);
    assert.equal(ev?.charge_status, "unknown");
    assert.equal(ev?.attempt, "failed");
    assert.notEqual(ev?.charge_status, "billed");
  });

  it("successful attempt is still unknown-charge not billed", () => {
    resetBillingHooksForTest();
    const r = compareBookkeeping(true, { task_id: "cccccccccccc", note: "z" });
    assert.equal(r.compare_ok, true);
    assert.equal(r.recorded, true);
    const ev = readLedger(5).find((e) => e.task_id === "cccccccccccc");
    assert.ok(ev);
    assert.equal(ev?.attempt, "ok");
    assert.equal(ev?.charge_status, "unknown");
    assert.notEqual(ev?.charge_status, "billed");
  });
});

describe("shanghai month", () => {
  it("uses Asia/Shanghai around the UTC month boundary", () => {
    assert.equal(shanghaiMonth(new Date("2026-08-31T15:00:00Z")), "2026-08");
    assert.equal(shanghaiMonth(new Date("2026-08-31T16:30:00Z")), "2026-09");
  });
});

describe("minimax remains picker", () => {
  it("keeps only documented quota fields and drops the raw envelope", () => {
    const remains = pickMinimaxRemains({
      remains_time: 12,
      usage_percent: 40,
      model_remains: [{ model: "secret-model" }, { model: "m2" }],
      start_time: "a",
      end_time: "b",
      raw: "drop-me",
      access_token: "tok",
    });
    assert.deepEqual(remains, {
      remains_time: 12,
      usage_percent: 40,
      model_count: 2,
      window_start: "a",
      window_end: "b",
    });
    assert.equal("raw" in remains, false);
    assert.equal("access_token" in remains, false);
    assert.equal("model_remains" in remains, false);
  });
});

describe("vendor snapshot", () => {
  function stubBce(opts: {
    cashOk?: boolean;
    cash?: number;
    cashError?: string;
    pages?: Array<{ ok: boolean; count: number; total: number }>;
    onCall?: (path: string) => void;
  }) {
    return (async (req: { path: string; query?: Record<string, string> }) => {
      opts.onCall?.(req.path);
      if (req.path.includes("cash/balance")) {
        const ok = opts.cashOk !== false;
        return {
          ok,
          status: ok ? 200 : 403,
          data: ok ? { cashBalance: opts.cash ?? 3 } : null,
          error: ok ? "" : opts.cashError || "no cash",
        };
      }
      const pageNo = Number(req.query?.pageNo || "1");
      const page = (opts.pages || [{ ok: true, count: 1, total: 1 }])[pageNo - 1];
      if (!page || !page.ok) {
        return { ok: false, status: 403, data: null, error: "no bill perm" };
      }
      const bills = Array.from({ length: page.count }, (_, i) => ({
        serviceTypeName: "OCR",
        chargeItemDesc: `row-${pageNo}-${i}`,
        cash: 1,
      }));
      return {
        ok: true,
        status: 200,
        data: { billMonth: "2026-08", totalCount: page.total, bills },
        error: "",
      };
    }) as NonNullable<Parameters<typeof setBillingHooksForTest>[0]["bceJson"]>;
  }

  async function withVendors<T>(run: () => Promise<T>): Promise<T> {
    process.env.BAIDU_CLOUD_AK = "ak-bill-aaaa";
    process.env.BAIDU_CLOUD_SK = "sk-bill-bbbb";
    process.env.MINIMAX_API_KEY = "mm-key-cccc";
    resetBillingCache();
    try {
      return await run();
    } finally {
      resetBillingCache();
      resetBillingHooksForTest();
      delete process.env.BAIDU_CLOUD_AK;
      delete process.env.BAIDU_CLOUD_SK;
      delete process.env.MINIMAX_API_KEY;
    }
  }

  it("pages Baidu month bills past the first 50", async () => {
    await withVendors(async () => {
      setBillingHooksForTest({
        bceJson: stubBce({
          pages: [
            { ok: true, count: BILL_PAGE_SIZE, total: 60 },
            { ok: true, count: 10, total: 60 },
          ],
        }),
        fetch: async () => new Response(JSON.stringify({ remains_time: 9 }), { status: 200 }),
      });
      const vendors = await loadVendorBills(true);
      const baidu = vendors.find((v) => v.vendor === "baidu");
      assert.equal(baidu?.bills.length, 60);
      assert.equal(baidu?.bills_truncated, false);
      assert.equal(baidu?.ok, true);
    });
  });

  it("marks truncated when a later page is missing", async () => {
    await withVendors(async () => {
      setBillingHooksForTest({
        bceJson: stubBce({
          pages: [{ ok: true, count: BILL_PAGE_SIZE, total: 80 }],
        }),
        fetch: async () => new Response(JSON.stringify({ remains_time: 9 }), { status: 200 }),
      });
      const vendors = await loadVendorBills(true);
      const baidu = vendors.find((v) => v.vendor === "baidu");
      assert.equal(baidu?.bills.length, BILL_PAGE_SIZE);
      assert.equal(baidu?.bills_truncated, true);
      assert.equal(baidu?.ok, false);
      assert.equal(baidu?.status, "partial");
    });
  });

  it("does not treat balance-ok + bill-fail as full success", async () => {
    await withVendors(async () => {
      setBillingHooksForTest({
        bceJson: stubBce({ pages: [{ ok: false, count: 0, total: 0 }] }),
        fetch: async () => new Response(JSON.stringify({ remains_time: 1 }), { status: 200 }),
      });
      const vendors = await loadVendorBills(true);
      const baidu = vendors.find((v) => v.vendor === "baidu");
      assert.equal(baidu?.balance_ok, true);
      assert.equal(baidu?.bills_ok, false);
      assert.equal(baidu?.ok, false);
      assert.equal(baidu?.status, "partial");
    });
  });

  it("drops cache when billing credentials change", async () => {
    await withVendors(async () => {
      const paths: string[] = [];
      setBillingHooksForTest({
        bceJson: stubBce({ onCall: (p) => paths.push(p) }),
        fetch: async () => new Response(JSON.stringify({ remains_time: 1 }), { status: 200 }),
      });
      await loadVendorBills(true);
      const first = paths.filter((p) => p.includes("cash/balance")).length;
      process.env.BAIDU_CLOUD_AK = "ak-bill-zzzz";
      process.env.BAIDU_CLOUD_SK = "sk-bill-wwww";
      await loadVendorBills(false);
      const second = paths.filter((p) => p.includes("cash/balance")).length;
      assert.equal(first, 1);
      assert.equal(second, 2);
    });
  });

  it("coalesces concurrent cold loads", async () => {
    await withVendors(async () => {
      let cash = 0;
      setBillingHooksForTest({
        bceJson: (async (req: { path: string; query?: Record<string, string> }) => {
          if (req.path.includes("cash/balance")) {
            cash += 1;
            await new Promise((r) => setTimeout(r, 20));
            return { ok: true, status: 200, data: { cashBalance: 2 }, error: "" };
          }
          return {
            ok: true,
            status: 200,
            data: { billMonth: "2026-08", totalCount: 1, bills: [{ serviceTypeName: "OCR" }] },
            error: "",
          };
        }) as NonNullable<Parameters<typeof setBillingHooksForTest>[0]["bceJson"]>,
        fetch: async () => new Response(JSON.stringify({ remains_time: 1 }), { status: 200 }),
      });
      await Promise.all([loadVendorBills(false), loadVendorBills(false), loadVendorBills(false)]);
      assert.equal(cash, 1);
    });
  });

  it("hydrates vendors on cold load and skips refetch while warm", async () => {
    await withVendors(async () => {
      let cash = 0;
      setBillingHooksForTest({
        bceJson: stubBce({
          onCall: (p) => {
            if (p.includes("cash/balance")) cash += 1;
          },
        }),
        fetch: async () => new Response(JSON.stringify({ remains_time: 1 }), { status: 200 }),
      });
      assert.equal(billingSnapshot().vendors.length, 0);
      await loadVendorBills(false);
      assert.ok(billingSnapshot().vendors.length >= 1);
      await loadVendorBills(false);
      assert.equal(cash, 1);
    });
  });

  it("MiniMax client payload has no raw vendor envelope", async () => {
    await withVendors(async () => {
      setBillingHooksForTest({
        bceJson: stubBce({}),
        fetch: async () =>
          new Response(JSON.stringify({ remains_time: 3, secret_blob: "nope", Authorization: "Bearer x" }), {
            status: 200,
          }),
      });
      const vendors = await loadVendorBills(true);
      const mm = vendors.find((v) => v.vendor === "minimax");
      assert.equal(mm?.remains?.remains_time, 3);
      assert.equal(JSON.stringify(mm).includes("secret_blob"), false);
      assert.equal(JSON.stringify(mm).includes("Bearer"), false);
      assert.equal("extra" in (mm || {}), false);
    });
  });

  it("snapshot labels the recency window", () => {
    const snap = billingSnapshot();
    assert.equal(snap.ledger_window, LEDGER_WINDOW);
    assert.match(snap.ledger_label, /本机任务调用记录/);
    assert.match(snap.ledger_label, /300/);
  });
});
