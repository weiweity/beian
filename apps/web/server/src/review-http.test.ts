import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.VITEST = "1";
process.env.WB_DATA_DIR = mkdtempSync(join(tmpdir(), "beian-review-http-"));
process.env.WB_HOST = "127.0.0.1";
process.env.WB_PORT = "0";

const { app } = await import("./index.js");
const { issueSession } = await import("./auth.js");
const { saveTask } = await import("./tasks.js");

type SeedHit = {
  id?: string;
  field?: string;
  status?: string;
  decision?: string;
};

type SeedTask = {
  id: string;
  title: string;
  product_name: string;
  type: string;
  status: string;
  error?: string;
  conclusion?: string;
  hits?: SeedHit[];
};

function authHeader() {
  const sess = issueSession("刘籽烨", "reviewer", "ou_review_http", "feishu");
  return { authorization: `Bearer ${sess.token}` };
}

function seed(task: SeedTask) {
  saveTask(task);
  return task.id;
}

function hit(over: Partial<SeedHit> = {}) {
  return {
    id: "h1",
    field: "净含量",
    status: "疑点",
    decision: "pending",
    ...over,
  };
}

describe("review http", () => {
  it("rejects an illegal decision value", async () => {
    const tid = seed({
      id: "aaaaaaaaaaaa",
      title: "精华",
      product_name: "精华",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit()],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "ai_pass" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /非法审核结论/);
  });

  it("rejects signing a compare_failed task", async () => {
    const tid = seed({
      id: "bbbbbbbbbbbb",
      title: "失败单",
      product_name: "失败单",
      type: "excel_pdf",
      status: "compare_failed",
      error: "对照失败",
      hits: [],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "看起来没问题" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可签字/);
  });

  it("rejects signing a completed task again", async () => {
    const tid = seed({
      id: "cccccccccccc",
      title: "已签",
      product_name: "已签",
      type: "excel_pdf",
      status: "completed",
      conclusion: "先前结论",
      hits: [hit({ status: "一致", decision: "confirm" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "再签一次" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可签字/);
  });

  it("records a human sign-off on a pending_review task", async () => {
    const tid = seed({
      id: "dddddddddddd",
      title: "待签",
      product_name: "待签",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit({ status: "疑点", decision: "confirm" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "人看过了，一致" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status?: string; conclusion?: string; complete_kind?: string };
    assert.equal(body.status, "completed");
    assert.equal(body.conclusion, "人看过了，一致");
    assert.equal(body.complete_kind, "signed");
  });

  it("still records confirm on an in_review hit", async () => {
    const tid = seed({
      id: "eeeeeeeeeeee",
      title: "审核中",
      product_name: "审核中",
      type: "excel_pdf",
      status: "in_review",
      hits: [hit()],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "confirm", note: "看过了" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status?: string; hits?: Array<{ decision?: string; note?: string }> };
    assert.equal(body.status, "in_review");
    assert.equal(body.hits?.[0]?.decision, "confirm");
    assert.equal(body.hits?.[0]?.note, "看过了");
  });
});
