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
const { resetJobsTestHooks, setJobsTestHooks } = await import("./jobs.js");

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

  it("GET task hides job_pid from the client", async () => {
    saveTask({
      id: "121212121212",
      title: "排队",
      product_name: "排队",
      type: "excel_pdf",
      status: "comparing",
      owner: "刘籽烨",
      job_kind: "compare",
      job_status: "running",
      job_pid: 4242,
    });
    const res = await app.request("/api/tasks/121212121212", { headers: authHeader() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal("job_pid" in body, false);
    assert.equal(body.job_status, "running");
  });

  it("decision is owner-scoped for reviewers", async () => {
    saveTask({
      id: "151515151515",
      title: "别人的点",
      product_name: "别人的点",
      type: "excel_pdf",
      status: "pending_review",
      owner: "刘籽烨",
      hits: [{ id: "h1", field: "净含量", status: "疑点", decision: "pending" }],
    });
    const other = issueSession("路人", "reviewer", "ou_other_decision", "feishu");
    const res = await app.request("/api/tasks/151515151515/decision", {
      method: "POST",
      headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
      body: JSON.stringify({ hit_id: "h1", decision: "confirm" }),
    });
    assert.equal(res.status, 403);
  });

  it("pages are owner-scoped for reviewers", async () => {
    saveTask({
      id: "161616161616",
      title: "别人的页",
      product_name: "别人的页",
      type: "excel_pdf",
      status: "pending_review",
      owner: "刘籽烨",
    });
    const other = issueSession("路人", "reviewer", "ou_other_pages", "feishu");
    const res = await app.request("/api/tasks/161616161616/pages/page_01.png", {
      headers: { authorization: `Bearer ${other.token}` },
    });
    assert.equal(res.status, 403);
  });

  it("rework is owner-scoped for reviewers", async () => {
    saveTask({
      id: "171717171717",
      title: "别人的对红",
      product_name: "别人的对红",
      type: "excel_pdf",
      status: "pending_review",
      owner: "刘籽烨",
      hits: [{ id: "h1", field: "净含量", status: "疑点", decision: "issue" }],
    });
    const other = issueSession("路人", "reviewer", "ou_other_rework", "feishu");
    const fd = new FormData();
    fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
    const res = await app.request("/api/tasks/171717171717/rework", {
      method: "POST",
      headers: { authorization: `Bearer ${other.token}` },
      body: fd,
    });
    assert.equal(res.status, 403);
  });

  it("complete is owner-scoped for reviewers", async () => {
    saveTask({
      id: "141414141414",
      title: "别人的签",
      product_name: "别人的签",
      type: "excel_pdf",
      status: "pending_review",
      owner: "刘籽烨",
      hits: [{ id: "h1", field: "净含量", status: "一致", decision: "confirm" }],
    });
    const other = issueSession("路人", "reviewer", "ou_other_complete", "feishu");
    const res = await app.request("/api/tasks/141414141414/complete", {
      method: "POST",
      headers: { ...{ authorization: `Bearer ${other.token}` }, "content-type": "application/json" },
      body: JSON.stringify({ conclusion: "偷签" }),
    });
    assert.equal(res.status, 403);
  });

  it("GET task is owner-scoped for reviewers", async () => {
    saveTask({
      id: "131313131313",
      title: "别人的",
      product_name: "别人的",
      type: "excel_pdf",
      status: "pending_review",
      owner: "刘籽烨",
    });
    const other = issueSession("路人", "reviewer", "ou_other_owner", "feishu");
    const res = await app.request("/api/tasks/131313131313", {
      headers: { authorization: `Bearer ${other.token}` },
    });
    assert.equal(res.status, 403);
  });

  it("health includes job queue snapshot", async () => {
    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { version?: string; jobs?: { ocr?: { running: number; queued: number } } };
    assert.match(String(body.version), /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(typeof body.jobs?.ocr?.running, "number");
    assert.equal(typeof body.jobs?.ocr?.queued, "number");
  });

  it("upload returns comparing before the worker finishes", async () => {
    setJobsTestHooks({
      runCompare: () => new Promise(() => {
        /* hang until process exit; slot is occupied on purpose */
      }),
    });
    try {
      const fd = new FormData();
      fd.set("product_name", "挂机精华");
      fd.set("title", "挂机精华");
      fd.set("pack_surface", "carton");
      fd.set("excel", new File([Buffer.from([0x50, 0x4b, 0x03, 0x04])], "a.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "a.pdf", { type: "application/pdf" }));
      const started = Date.now();
      const res = await app.request("/api/tasks/upload", { method: "POST", headers: authHeader(), body: fd });
      const elapsed = Date.now() - started;
      assert.equal(res.status, 200);
      assert.ok(elapsed < 2000, `upload waited ${elapsed}ms`);
      const body = (await res.json()) as { status?: string; job_status?: string; job_pid?: number };
      assert.equal(body.status, "comparing");
      assert.ok(body.job_status === "queued" || body.job_status === "running");
      assert.equal("job_pid" in body, false);
    } finally {
      resetJobsTestHooks();
    }
  });

  it("rework returns comparing before the worker finishes", async () => {
    setJobsTestHooks({
      runRework: () =>
        new Promise(() => {
          /* hang */
        }),
    });
    try {
      const tid = seed({
        id: "181818181818",
        title: "对红立即",
        product_name: "对红立即",
        type: "excel_pdf",
        status: "completed",
        complete_kind: "rework",
        conclusion: "待设计改稿",
        hits: [hit({ decision: "issue" })],
      });
      const fd = new FormData();
      fd.set("pdf", new File([Buffer.from("%PDF-1.4\n")], "v2.pdf", { type: "application/pdf" }));
      const started = Date.now();
      const res = await app.request(`/api/tasks/${tid}/rework`, {
        method: "POST",
        headers: authHeader(),
        body: fd,
      });
      assert.equal(res.status, 200);
      assert.ok(Date.now() - started < 2000, "rework waited");
      const body = (await res.json()) as { status?: string; job_kind?: string; job_status?: string; job_pid?: number };
      assert.equal(body.status, "comparing");
      assert.equal(body.job_kind, "rework");
      assert.ok(body.job_status === "queued" || body.job_status === "running");
      assert.equal("job_pid" in body, false);
      const again = await app.request(`/api/tasks/${tid}/rework`, {
        method: "POST",
        headers: authHeader(),
        body: fd,
      });
      assert.equal(again.status, 409);
    } finally {
      resetJobsTestHooks();
    }
  });

  it("rejects a second rework while the first is still queued", async () => {
    const tid = seed({
      id: "141414141414",
      title: "对红排队",
      product_name: "对红排队",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    const { loadTask, saveTask } = await import("./tasks.js");
    const t = loadTask(tid);
    t.job_kind = "rework";
    t.job_status = "queued";
    saveTask(t);
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /对红还在排队或正在跑/);
  });

  it("rejects a rework upload that is not a PDF", async () => {
    const tid = seed({
      id: "151515151515",
      title: "坏稿",
      product_name: "坏稿",
      type: "excel_pdf",
      status: "completed",
      complete_kind: "rework",
      conclusion: "待设计改稿",
      hits: [hit({ decision: "issue" })],
    });
    const fd = new FormData();
    fd.set("pdf", new File([Buffer.from("not-a-pdf")], "a.txt", { type: "text/plain" }));
    const res = await app.request(`/api/tasks/${tid}/rework`, {
      method: "POST",
      headers: authHeader(),
      body: fd,
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { detail?: string };
    assert.match(String(body.detail || ""), /不是有效的 PDF/);
  });
});
