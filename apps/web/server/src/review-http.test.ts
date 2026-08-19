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
  complete_kind?: string;
  hits?: SeedHit[];
  hits_v2?: SeedHit[];
  pages_v2?: Array<{ url?: string }>;
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

  it("rejects a decision on a compare_failed task", async () => {
    const tid = seed({
      id: "ffffffffffff",
      title: "失败不可点",
      product_name: "失败不可点",
      type: "excel_pdf",
      status: "compare_failed",
      error: "对照失败",
      hits: [hit()],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "confirm" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可审核/);
  });

  it("rejects rework on a signed-clean task", async () => {
    const tid = seed({
      id: "333333333333",
      title: "干净签字",
      product_name: "干净签字",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "signed",
      conclusion: "人看过了",
      hits: [hit({ status: "一致", decision: "confirm" })],
    });
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可对红/);
  });

  it("lets a completed-rework task reach the rework pdf check", async () => {
    const tid = seed({
      id: "222222222222",
      title: "已签待对红",
      product_name: "已签待对红",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /需要改稿后的 PDF/);
  });

  it("rejects rework on a compare_failed task", async () => {
    const tid = seed({
      id: "111111111111",
      title: "失败不可对红",
      product_name: "失败不可对红",
      type: "excel_pdf",
      status: "compare_failed",
      error: "对照失败",
      hits: [],
    });
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可对红/);
  });

  it("blocks sign-off when v2 hits still have pending 疑点", async () => {
    const tid = seed({
      id: "444444444444",
      title: "对红后",
      product_name: "对红后",
      type: "excel_pdf",
      status: "in_review",
      hits: [hit({ status: "一致", decision: "confirm" })],
      hits_v2: [hit({ id: "v2_h1", status: "疑点", decision: "pending" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "第二轮也过了" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /仍有 1 条疑点/);
  });

  it("records a v2 hit decision", async () => {
    const tid = seed({
      id: "555555555555",
      title: "对红点字段",
      product_name: "对红点字段",
      type: "excel_pdf",
      status: "in_review",
      hits: [hit({ status: "一致", decision: "confirm" })],
      hits_v2: [hit({ id: "v2_h1", status: "疑点", decision: "pending" })],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "v2_h1", decision: "confirm" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hits_v2?: Array<{ id?: string; decision?: string }> };
    assert.equal(body.hits_v2?.[0]?.decision, "confirm");
  });

  it("rejects a decision on a missing hit", async () => {
    const tid = seed({
      id: "666666666666",
      title: "没有这个字段",
      product_name: "没有这个字段",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit()],
    });
    const res = await app.request(`/api/tasks/${tid}/decision`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "nope", decision: "confirm" }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /字段不存在/);
  });

  it("rejects sign-off without a conclusion", async () => {
    const tid = seed({
      id: "777777777777",
      title: "没写结论",
      product_name: "没写结论",
      type: "excel_pdf",
      status: "pending_review",
      hits: [hit({ status: "一致", decision: "confirm" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "   " }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /请写下结论/);
  });

  it("marks complete_kind rework when any hit is issue", async () => {
    const tid = seed({
      id: "888888888888",
      title: "有错待改",
      product_name: "有错待改",
      type: "excel_pdf",
      status: "in_review",
      hits: [hit({ decision: "issue" })],
    });
    const res = await app.request(`/api/tasks/${tid}/complete`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "待设计改稿" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { complete_kind?: string; status?: string };
    assert.equal(body.status, "completed");
    assert.equal(body.complete_kind, "rework");
  });

  it("rejects a second rework after pages_v2 already exist", async () => {
    const tid = seed({
      id: "999999999999",
      title: "已经对过红",
      product_name: "已经对过红",
      type: "excel_pdf",
      status: "in_review",
      hits: [hit({ decision: "issue" })],
      hits_v2: [hit({ id: "v2_h1", decision: "pending" })],
      pages_v2: [{ url: "/x.png" }],
    });
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /当前状态不可对红/);
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
