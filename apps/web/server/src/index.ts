import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { cacheHeaderFor, REDIRECT_CACHE } from "./cacheHeaders.js";
import { isSpaPath, legacyDeskRedirect, spaIndexAction } from "./spaIndex.js";
import { COOKIE, DATA_DIR, HOST, PORT, REPO_ROOT, UI_DIST, UI_PUBLIC, cookieSecure } from "./config.js";
import { billingSnapshot, loadVendorBills, resetBillingCache } from "./billing.js";
import { notifyTaskComplete, sendText } from "./notify.js";
import {
  decorateQueueAhead,
  enqueue,
  publicTask,
  queueSnapshot,
  reclaimOnBoot,
} from "./jobs.js";
import {
  feishuRedirect,
  getSetting,
  publicBase,
  adminOnlyKeys,
  publicView,
  runProbe,
  saveSettings,
} from "./settings.js";
import { scanLocalApps } from "./scanLocal.js";
import {
  authorizeUrl,
  beginOAuth,
  consumeOAuth,
  createDisplaySession,
  displayLoginAllowed,
  exchangeCode,
  getSession,
  logout as dropSession,
  hasPerm,
  permissionsFor,
  oauthReady,
  sanitizeNext,
  lockAllowedTenant,
  sessionFromFeishu,
  type Role,
  type Session,
} from "./auth.js";
import {
  assertBlenderReady,
  assertCanAccessMockup,
  deleteMockup,
  fileOf,
  findMockupBySourceReceipt,
  getJob,
  isWhiteFile,
  listJobsFor,
  publicMockup,
  queueMockup,
} from "./mockup.js";
import { assertIllustratorReady } from "./aiRaster.js";
import { skipPackSheetField } from "./sheetSkip.js";
import {
  consumeReceipt,
  createUploadAdmission,
  discardReceipt,
  listReceipts,
  loadReceipt,
  MAX_UPLOAD_BODY_BYTES,
  purgeReceiptFiles,
  receiptOwner,
  restoreReceipt,
  stageBuffers,
  tooLarge,
  underReceiptDir,
  UPLOAD_BODY_TOO_LARGE,
  oversizeMessage,
  uploadTotalTooLarge,
} from "./uploads.js";
import {
  activeHits,
  assertCanAccessTask,
  assertTid,
  deleteTask,
  findTaskBySourceReceipt,
  isHitDecision,
  isReviewableStatus,
  isReworkableTask,
  listTasks,
  loadTask,
  newTid,
  nowIso,
  saveTask,
  viewerFromSession,
} from "./tasks.js";


type Env = { Variables: { session: Session } };

const app = new Hono<Env>();
const VERSION = "0.13.1.0";
const uploadAdmission = createUploadAdmission(1);

app.use(compress());

app.use("/api/*", async (c, next) => {
  const tok = c.req.header("authorization") || (getCookie(c, COOKIE) ? `Bearer ${getCookie(c, COOKIE)}` : "");
  const sess = getSession(tok);
  if (sess) c.set("session", sess);
  await next();
});

function need(c: { get: (k: "session") => Session | undefined }, perm: string): Session {
  const s = c.get("session");
  if (!s) throw new HTTPException(401, { message: "未登录" });
  if (!hasPerm(s.role as Role, perm)) throw new HTTPException(403, { message: "没有权限" });
  return s;
}

function boom(err: unknown): never {
  const status = typeof err === "object" && err && "status" in err ? Number((err as { status: number }).status) : 500;
  const message = err instanceof Error ? err.message : String(err);
  throw new HTTPException((status || 500) as 400, { message });
}

function pngMagicAt(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(8);
    const n = readSync(fd, buf, 0, 8, 0);
    return (
      n >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ detail: err.message }, err.status);
  }
  const status = typeof err === "object" && err && "status" in err ? Number((err as { status: number }).status) : 500;
  const message = err instanceof Error ? err.message : "服务器错误";
  const code = status >= 400 && status < 600 ? status : 500;
  return c.json({ detail: message }, code as 400);
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    version: VERSION,
    runtime: "typescript",
    jobs: queueSnapshot(),
    feishu_notify: /^(1|true|yes|on)$/i.test(getSetting("FEISHU_ENABLED")) && Boolean(getSetting("FEISHU_OPEN_ID")),
  }),
);

app.get("/api/auth/methods", (c) =>
  c.json({
    feishu: oauthReady(),
    display_login: displayLoginAllowed(c.req.header("host") || ""),
    login_url: "/api/auth/feishu/login",
    public_base: publicBase(),
  }),
);

app.get("/api/auth/me", (c) => {
  const s = c.get("session");
  if (!s) return c.json({ logged_in: false, display_name: null, avatar_url: null, role: null, perms: [] });
  return c.json({
    logged_in: true,
    display_name: s.display_name,
    avatar_url: s.avatar_url || "",
    role: s.role,
    open_id: s.open_id || "",
    perms: permissionsFor(s.role),
    expires_at: s.expires_at,
  });
});

app.post("/api/auth/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { display_name?: string };
  try {
    const sess = createDisplaySession(body.display_name || "", c.req.header("host") || "");
    setCookie(c, COOKIE, sess.token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecure(),
      path: "/",
      maxAge: 7 * 24 * 3600,
    });
    return c.json(sess);
  } catch (e) {
    boom(e);
  }
});

app.post("/api/auth/logout", (c) => {
  dropSession(c.req.header("authorization") || (getCookie(c, COOKIE) ? `Bearer ${getCookie(c, COOKIE)}` : ""));
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

const HINT = "wb_login_hint";

function failLogin(c: Context, code: string, hint: string) {
  setCookie(c, HINT, hint.slice(0, 200), {
    httpOnly: false,
    sameSite: "Lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: 120,
  });
  return c.redirect(`/?feishu_error=${encodeURIComponent(code)}`, 302);
}

app.get("/api/auth/feishu/login", (c) => {
  if (!oauthReady()) throw new HTTPException(503, { message: "未配置 FEISHU_APP_SECRET" });
  const { state, challenge } = beginOAuth(c.req.query("next") || "");
  return c.redirect(authorizeUrl(feishuRedirect(), state, challenge), 302);
});

app.get("/api/auth/feishu/callback", async (c) => {
  const error = c.req.query("error") || "";
  if (error) return failLogin(c, "denied", "已取消飞书授权。");
  const state = c.req.query("state") || "";
  const code = c.req.query("code") || "";
  const oauth = consumeOAuth(state);
  if (!oauth) return failLogin(c, "expired", "登录已过期，请再点一次飞书登录。");
  try {
    const ident = await exchangeCode(code, feishuRedirect(), oauth.verifier);
    const expected = await lockAllowedTenant(ident.tenant_key);
    if (expected && ident.tenant_key && ident.tenant_key !== expected) {
      return failLogin(c, "forbidden", "只允许伸美公司的飞书号进入。");
    }
    const sess = sessionFromFeishu(ident.open_id, ident.name, ident.tenant_key, expected, {
      provision: true,
      nickname: ident.nickname,
      avatar_url: ident.avatar_url,
    });
    setCookie(c, COOKIE, sess.token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecure(),
      path: "/",
      maxAge: 7 * 24 * 3600,
    });
    return c.redirect(`${publicBase()}${oauth.next || "/reviewup"}`, 302);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "登录失败";
    const code = /白名单/.test(msg) ? "forbidden" : "failed";
    return failLogin(c, code, msg);
  }
});

app.get("/api/tasks", (c) => {
  const s = need(c, "read");
  const q = c.req.query("q") || "";
  return c.json(decorateQueueAhead(listTasks(q, viewerFromSession(s))));
});

app.get("/api/tasks/:tid", (c) => {
  const s = need(c, "read");
  try {
    const task = loadTask(c.req.param("tid"));
    assertCanAccessTask(task, viewerFromSession(s));
    return c.json(publicTask(task, viewerFromSession(s)));
  } catch (e) {
    boom(e);
  }
});

app.delete("/api/tasks/:tid", (c) => {
  const s = need(c, "delete");
  try {
    const task = loadTask(c.req.param("tid"));
    assertCanAccessTask(task, viewerFromSession(s));
    deleteTask(task.id);
    return c.json({ ok: true });
  } catch (e) {
    boom(e);
  }
});

app.get("/api/uploads", (c) => {
  const s = need(c, "create");
  return c.json(listReceipts(receiptOwner(s)));
});

app.delete("/api/uploads/:id", (c) => {
  const s = need(c, "create");
  return c.json({ ok: discardReceipt(c.req.param("id"), receiptOwner(s)) });
});

app.post(
  "/api/uploads",
  async (c, next) => {
    need(c, "create");
    await uploadAdmission.run(next);
  },
  bodyLimit({
    maxSize: MAX_UPLOAD_BODY_BYTES,
    onError: (c) => c.json({ detail: UPLOAD_BODY_TOO_LARGE }, 413),
  }),
  async (c) => {
    const s = need(c, "create");
    const body = await c.req.parseBody({ all: true });
    const selected: { field: string; file: File }[] = [];
    function take(field: string, file: unknown) {
      if (!(file instanceof File)) return;
      selected.push({ field, file });
    }
    take("excel", body.excel);
    take("pdf", body.pdf);
    take("ai", body.file || body.ai);
    if (!selected.length) throw new HTTPException(400, { message: "没有文件" });
    const rawClientUploadId = body.client_upload_id;
    const clientUploadId =
      typeof rawClientUploadId === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(rawClientUploadId)
        ? rawClientUploadId
        : undefined;
    if (uploadTotalTooLarge(selected.map(({ file }) => file.size))) {
      throw new HTTPException(413, { message: UPLOAD_BODY_TOO_LARGE });
    }
    const parts: { field: string; name: string; buf: Buffer }[] = [];
    for (const { field, file } of selected) {
      parts.push({ field, name: file.name, buf: Buffer.from(await file.arrayBuffer()) });
    }
    try {
      const rec = stageBuffers(receiptOwner(s), parts, clientUploadId);
      return c.json({
        receipt: rec.id,
        client_upload_id: rec.client_upload_id,
        files: rec.files.map((f) => ({ field: f.field, name: f.name, bytes: f.bytes })),
      });
    } catch (err) {
      throw new HTTPException(400, { message: err instanceof Error ? err.message : "上传失败" });
    }
  },
);

app.post("/api/tasks/start", async (c) => {
  const s = need(c, "create");
  const body = (await c.req.json()) as {
    receipt?: string;
    product_name?: string;
    title?: string;
    pack_surface?: string;
  };
  const product = String(body.product_name || "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 80);
  if (!product) throw new HTTPException(400, { message: "品名必填" });
  const owner = receiptOwner(s);
  const receiptId = String(body.receipt || "");
  const existing = findTaskBySourceReceipt(receiptId, owner);
  if (existing) {
    discardReceipt(receiptId, owner);
    purgeReceiptFiles(receiptId);
    return c.json(publicTask(existing, viewerFromSession(s)));
  }
  const peeked = loadReceipt(receiptId, owner);
  if (!peeked) throw new HTTPException(400, { message: "上传已过期，请重新传文件" });
  if (!peeked.files.some((f) => f.field === "excel") || !peeked.files.some((f) => f.field === "pdf")) {
    throw new HTTPException(400, { message: "需要 excel + 包装 PDF" });
  }
  const rec = consumeReceipt(receiptId, owner);
  if (!rec) {
    const recovered = findTaskBySourceReceipt(receiptId, owner);
    if (recovered) return c.json(publicTask(recovered, viewerFromSession(s)));
    throw new HTTPException(400, { message: "上传已过期，请重新传文件" });
  }
  const excel = rec.files.find((f) => f.field === "excel");
  const pdf = rec.files.find((f) => f.field === "pdf");
  if (!excel || !pdf || !underReceiptDir(rec.id, excel.path) || !underReceiptDir(rec.id, pdf.path)) {
    purgeReceiptFiles(rec.id);
    throw new HTTPException(400, { message: "上传已过期，请重新传文件" });
  }
  const tid = newTid();
  const dir = join(DATA_DIR, "uploads", tid);
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(excel.path, join(dir, "source.xlsx"));
    copyFileSync(pdf.path, join(dir, "artwork.pdf"));
    saveTask({
      id: tid,
      title: String(body.title || product).slice(0, 80),
      product_name: product,
      type: "excel_pdf",
      status: "comparing",
      created_at: nowIso(),
      owner: viewerFromSession(s).id,
      created_by: s.display_name,
      pack_surface: String(body.pack_surface || "carton"),
      job_kind: "compare",
      job_status: "queued",
      source_receipt: receiptId,
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    const restored = restoreReceipt(rec);
    console.error("create compare task failed", {
      problem: "上传回执已领取，但审核单文件没有准备完成",
      cause: err instanceof Error ? err.message : String(err),
      fix: restored ? "回执已恢复，可重新开始对照" : "回执未能恢复，需要重新上传",
    });
    throw new HTTPException(500, {
      message: restored ? "创建审核单失败，请再点一次开始对照" : "创建审核单失败，请重新上传",
    });
  }
  purgeReceiptFiles(rec.id);
  try {
    enqueue({ kind: "compare", id: tid });
  } catch (err) {
    console.warn("enqueue compare failed:", err instanceof Error ? err.message : err);
  }
  return c.json(publicTask(loadTask(tid), viewerFromSession(s)));
});

app.post("/api/mockups/start", async (c) => {
  const s = need(c, "create");
  const body = (await c.req.json()) as { receipt?: string; title?: string; product_name?: string };
  const owner = receiptOwner(s);
  const receiptId = String(body.receipt || "");
  const existing = findMockupBySourceReceipt(receiptId, owner);
  if (existing) {
    discardReceipt(receiptId, owner);
    purgeReceiptFiles(receiptId);
    return c.json(decorateQueueAhead([publicMockup(existing)])[0]);
  }
  try {
    assertBlenderReady();
    assertIllustratorReady();
  } catch (e) {
    boom(e);
  }
  const peeked = loadReceipt(receiptId, owner);
  if (!peeked) throw new HTTPException(400, { message: "上传已过期，请重新传文件" });
  if (!peeked.files.some((f) => f.field === "ai")) throw new HTTPException(400, { message: "需要 .ai 稿件" });
  const rec = consumeReceipt(receiptId, owner);
  if (!rec) {
    const recovered = findMockupBySourceReceipt(receiptId, owner);
    if (recovered) return c.json(decorateQueueAhead([publicMockup(recovered)])[0]);
    throw new HTTPException(400, { message: "上传已过期，请重新传文件" });
  }
  const ai = rec.files.find((f) => f.field === "ai");
  if (!ai || !underReceiptDir(rec.id, ai.path)) {
    purgeReceiptFiles(rec.id);
    throw new HTTPException(400, { message: "需要 .ai 稿件" });
  }
  const id = newTid();
  const dir = join(DATA_DIR, "mockups", id);
  let job: ReturnType<typeof queueMockup>;
  try {
    mkdirSync(dir, { recursive: true });
    const src = join(dir, ai.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "art.ai");
    copyFileSync(ai.path, src);
    const title = String(body.title || body.product_name || "").trim().slice(0, 80);
    job = queueMockup({
      id,
      sourcePath: src,
      sourceReceipt: receiptId,
      ownerId: viewerFromSession(s).id,
      displayName: s.display_name,
      title,
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    const restored = restoreReceipt(rec);
    console.error("create mockup task failed", {
      problem: "上传回执已领取，但打样单文件没有准备完成",
      cause: err instanceof Error ? err.message : String(err),
      fix: restored ? "回执已恢复，可重新开始打样" : "回执未能恢复，需要重新上传",
    });
    throw new HTTPException(500, {
      message: restored ? "创建打样单失败，请再点一次开始打样" : "创建打样单失败，请重新上传",
    });
  }
  purgeReceiptFiles(rec.id);
  try {
    enqueue({ kind: "mockup", id });
  } catch (err) {
    console.warn("enqueue mockup failed:", err instanceof Error ? err.message : err);
  }
  return c.json(decorateQueueAhead([publicMockup(getJob(id) || job)])[0]);
});

app.post("/api/tasks/:tid/decision", async (c) => {
  const s = need(c, "decide");
  const tid = assertTid(c.req.param("tid"));
  const body = (await c.req.json()) as { hit_id?: string; decision?: string; note?: string };
  const task = loadTask(tid);
  assertCanAccessTask(task, viewerFromSession(s));
  if (!isReviewableStatus(task.status)) {
    throw new HTTPException(400, { message: "当前状态不可审核" });
  }
  if (!isHitDecision(body.decision)) {
    throw new HTTPException(400, { message: "非法审核结论" });
  }
  const hit = activeHits(task).find((h) => h.id === body.hit_id);
  if (!hit) throw new HTTPException(404, { message: "字段不存在" });
  hit.decision = body.decision;
  if (body.note != null) hit.note = String(body.note).trim();
  task.status = "in_review";
  task.actor = s.display_name;
  task.audit = [...(task.audit || []), { at: nowIso(), actor: s.display_name, action: "decision", hit_id: body.hit_id }];
  saveTask(task);
  return c.json(publicTask(task, viewerFromSession(s)));
});

app.post("/api/tasks/:tid/complete", async (c) => {
  const s = need(c, "complete");
  const task = loadTask(c.req.param("tid"));
  assertCanAccessTask(task, viewerFromSession(s));
  if (!isReviewableStatus(task.status)) {
    throw new HTTPException(400, { message: "当前状态不可签字" });
  }
  const body = (await c.req.json().catch(() => ({}))) as { conclusion?: string };
  const hits = activeHits(task).filter((h) => !skipPackSheetField(h.field));
  const pending = hits.filter(
    (h) => (h.status === "疑点" || h.status === "缺失") && (h.decision || "pending") === "pending",
  );
  if (pending.length) throw new HTTPException(400, { message: `仍有 ${pending.length} 条疑点/缺失未处理` });
  const conclusion = (body.conclusion || "").trim();
  if (!conclusion) throw new HTTPException(400, { message: "请写下结论" });
  const issues = hits.filter((h) => h.decision === "issue");
  task.status = "completed";
  task.completed_at = nowIso();
  task.completed_by = s.display_name;
  task.conclusion = conclusion;
  task.complete_kind = issues.length ? "rework" : "signed";
  saveTask(task);
  void notifyTaskComplete(task, s.display_name).catch((err) => {
    console.warn("feishu notify failed:", err instanceof Error ? err.message : err);
  });
  return c.json(publicTask(task, viewerFromSession(s)));
});

app.post(
  "/api/tasks/:tid/rework",
  async (c, next) => {
    const s = need(c, "create");
    const task = loadTask(assertTid(c.req.param("tid")));
    assertCanAccessTask(task, viewerFromSession(s));
    await next();
  },
  async (_c, next) => {
    await uploadAdmission.run(next);
  },
  bodyLimit({
    maxSize: MAX_UPLOAD_BODY_BYTES,
    onError: (c) => c.json({ detail: UPLOAD_BODY_TOO_LARGE }, 413),
  }),
  async (c) => {
    const s = need(c, "create");
    const tid = assertTid(c.req.param("tid"));
    // 排队期间状态可能变化，解析前后都以当前落盘任务为准。
    const beforeParse = loadTask(tid);
    assertCanAccessTask(beforeParse, viewerFromSession(s));
    if (beforeParse.job_status === "queued" || beforeParse.job_status === "running") {
      throw new HTTPException(409, { message: "对红还在排队或正在跑" });
    }
    if (!isReworkableTask(beforeParse)) {
      throw new HTTPException(400, { message: "当前状态不可对红" });
    }
    const body = await c.req.parseBody();
    const pdf = body.pdf;
    if (!(pdf instanceof File)) throw new HTTPException(400, { message: "需要改稿后的 PDF" });
    if (uploadTotalTooLarge([pdf.size])) {
      throw new HTTPException(413, { message: UPLOAD_BODY_TOO_LARGE });
    }
    if (tooLarge(pdf.size)) {
      throw new HTTPException(400, { message: oversizeMessage() });
    }
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    // parseBody / arrayBuffer 会让出事件循环；另一标签可能已经删单、签字或启动
    // 另一轮作业。最后一次 await 之后重新读盘，此后同步落盘，不让旧对象复活任务。
    const task = loadTask(tid);
    assertCanAccessTask(task, viewerFromSession(s));
    if (task.job_status === "queued" || task.job_status === "running") {
      throw new HTTPException(409, { message: "对红还在排队或正在跑" });
    }
    if (!isReworkableTask(task)) {
      throw new HTTPException(400, { message: "当前状态不可对红" });
    }
    if (pdfBuf.length < 5 || pdfBuf.subarray(0, 4).toString("utf8") !== "%PDF") {
      throw new HTTPException(400, { message: "不是有效的 PDF" });
    }
    const dir = join(DATA_DIR, "uploads", tid);
    mkdirSync(dir, { recursive: true });
    const pdfPath = join(dir, "artwork_v2.pdf");
    writeFileSync(pdfPath, pdfBuf);
    task.status_before_job = task.status;
    task.status = "comparing";
    task.job_kind = "rework";
    task.job_status = "queued";
    task.job_error = undefined;
    task.reclaim_count = 0;
    delete task.job_pid;
    delete task.job_finished_at;
    task.notify_job_id = undefined;
    task.notify_sent = false;
    saveTask(task);
    try {
      enqueue({ kind: "rework", id: tid });
    } catch (err) {
      console.warn("enqueue rework failed:", err instanceof Error ? err.message : err);
    }
    return c.json(publicTask(loadTask(tid), viewerFromSession(s)));
  },
);

app.get("/api/tasks/:tid/pages/:name", (c) => {
  const s = need(c, "read");
  const tid = assertTid(c.req.param("tid"));
  assertCanAccessTask(loadTask(tid), viewerFromSession(s));
  const name = c.req.param("name");
  if (!/^page_\d{2}\.png$/.test(name)) throw new HTTPException(400, { message: "非法页名" });
  const p = join(DATA_DIR, "uploads", tid, "pages", name);
  if (!existsSync(p)) throw new HTTPException(404, { message: "没有这一页" });
  return new Response(readFileSync(p), { headers: { "Content-Type": "image/png" } });
});

app.get("/api/tasks/:tid/pages/:side/:name", (c) => {
  const s = need(c, "read");
  const tid = assertTid(c.req.param("tid"));
  assertCanAccessTask(loadTask(tid), viewerFromSession(s));
  const side = c.req.param("side");
  const name = c.req.param("name");
  if (!/^[a-z0-9]+$/i.test(side) || !/^page_\d{2}\.png$/.test(name)) {
    throw new HTTPException(400, { message: "非法路径" });
  }
  const p = join(DATA_DIR, "uploads", tid, "pages", side, name);
  if (!existsSync(p)) throw new HTTPException(404, { message: "没有这一页" });
  return new Response(readFileSync(p), { headers: { "Content-Type": "image/png" } });
});

app.get("/api/settings", (c) => {
  need(c, "read");
  const view = publicView();
  const q = queueSnapshot();
  return c.json({
    ...view,
    health: {
      ...view.health,
      queue: {
        ok: true,
        title: "对照 / 打样排队",
        detail: `对照 ${q.ocr.running} 在跑 / ${q.ocr.queued} 排队 · 打样 ${q.blender.running} 在跑 / ${q.blender.queued} 排队`,
      },
    },
  });
});

app.post("/api/settings", async (c) => {
  const s = need(c, "create");
  const body = (await c.req.json().catch(() => ({}))) as { values?: Record<string, string> } & Record<
    string,
    string
  >;
  const values = body.values && typeof body.values === "object" ? body.values : body;
  const patch: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === "values") continue;
    if (typeof v === "string") patch[k] = v;
  }
  const locked = adminOnlyKeys().filter((k) => k in patch);
  if (locked.length && s.role !== "admin") {
    throw new HTTPException(403, { message: "改本机软件路径需要管理员" });
  }
  const { restart } = saveSettings(patch);
  const billingKeys = [
    "BAIDU_CLOUD_AK",
    "BAIDU_CLOUD_SK",
    "BAIDU_OCR_API_KEY",
    "BAIDU_OCR_SECRET_KEY",
    "MINIMAX_API_KEY",
  ];
  if (billingKeys.some((k) => k in patch)) resetBillingCache();
  return c.json({ ...publicView(), restart });
});

app.post("/api/settings/probe", async (c) => {
  const s = need(c, "read");
  const body = (await c.req.json().catch(() => ({}))) as { id?: string };
  const id = String(body.id || "").trim();
  if (!id) throw new HTTPException(400, { message: "缺少探测 id" });
  if (id === "lark_send") {
    need(c, "create");
    const to = (s.open_id || "").trim();
    if (!to) {
      return c.json({ id: "lark", ok: false, message: "显示名登录没有 open_id，发不了测试" });
    }
    const r = await sendText("【审稿台】推送测试。发给当前登录。", to, { force: true });
    if (r.ok) {
      const patch: Record<string, string> = { FEISHU_ENABLED: "true" };
      if (!getSetting("FEISHU_OPEN_ID").trim()) patch.FEISHU_OPEN_ID = to;
      saveSettings(patch);
      const via = r.via === "cli" ? "lark-cli" : "飞书应用";
      return c.json({
        id: "lark",
        ok: true,
        message: `已用${via}发给当前登录 ${s.display_name || to.slice(0, 8)}`,
      });
    }
    return c.json({ id: "lark", ok: false, message: r.reason || "发送失败" });
  }
  return c.json(await runProbe(id));
});

app.post("/api/settings/scan", (c) => {
  const s = need(c, "read");
  if (s.role !== "admin") throw new HTTPException(403, { message: "扫描这台电脑需要管理员" });
  const result = scanLocalApps();
  return c.json({
    hits: result.hits,
    timedOut: result.timedOut,
    roots: result.roots,
    message: result.timedOut
      ? "扫描超时，已找到的留下。没有全盘搜。"
      : result.hits.length
        ? `白名单 ${result.roots.length} 个目录，也搜了 PATH。点采用才写入。`
        : `没扫到 Blender / Illustrator。搜过：${result.roots.join("、") || "无"}；也搜了 PATH。`,
  });
});

app.get("/api/settings/billing", async (c) => {
  need(c, "read");
  await loadVendorBills(false);
  return c.json(billingSnapshot());
});

app.post("/api/settings/billing/refresh", async (c) => {
  need(c, "read");
  const vendors = await loadVendorBills(true);
  return c.json({ ...billingSnapshot(), vendors });
});

app.get("/api/mockups", (c) => {
  const s = need(c, "read");
  return c.json(decorateQueueAhead(listJobsFor(viewerFromSession(s)).map(publicMockup)));
});

app.get("/api/mockups/:id", (c) => {
  const s = need(c, "read");
  const job = getJob(assertTid(c.req.param("id")));
  if (!job) throw new HTTPException(404, { message: "没有这单打样" });
  assertCanAccessMockup(job, viewerFromSession(s));
  return c.json(decorateQueueAhead([publicMockup(job)])[0]);
});

app.delete("/api/mockups/:id", (c) => {
  const s = need(c, "delete");
  try {
    const job = getJob(assertTid(c.req.param("id")));
    if (!job) throw new HTTPException(404, { message: "没有这单打样" });
    assertCanAccessMockup(job, viewerFromSession(s));
    deleteMockup(job.id);
    return c.json({ ok: true });
  } catch (e) {
    boom(e);
  }
});

app.get("/api/mockups/:id/files/:key", (c) => {
  const s = need(c, "read");
  const job = getJob(assertTid(c.req.param("id")));
  if (!job) throw new HTTPException(404, { message: "没有这单打样" });
  assertCanAccessMockup(job, viewerFromSession(s));
  const key = c.req.param("key");
  const f = fileOf(job, key);
  if (!f?.path || !existsSync(f.path)) throw new HTTPException(404, { message: "文件还没有" });
  if (!isWhiteFile(key, f.name)) {
    throw new HTTPException(415, { message: "这张白底图坏了，不是 PNG。回到打样台重新打。" });
  }
  const lower = f.name.toLowerCase();
  const type = lower.endsWith(".glb")
    ? "model/gltf-binary"
    : lower.endsWith(".png")
      ? "image/png"
      : lower.endsWith(".pdf")
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (type === "image/png" && !pngMagicAt(f.path)) {
    throw new HTTPException(415, { message: "这张白底图坏了，不是 PNG。回到打样台重新打。" });
  }
  const ascii = f.name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  const encoded = encodeURIComponent(f.name);
  const forceAttach = c.req.query("download") === "1";
  const disposition =
    forceAttach || !(type.startsWith("image/") || type.startsWith("model/")) ? "attachment" : "inline";
  return new Response(Readable.toWeb(createReadStream(f.path)) as ReadableStream, {
    headers: {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    },
  });
});

// root = ui/public, so /brand/logo-mark.png → ui/public/brand/logo-mark.png.
// Do not regex-strip /brand from UI_BRAND: Windows join uses `\brand`, the
// replace is a no-op, and serveStatic looks in public\brand\brand\… (404).
app.use("/brand/*", async (c, next) => {
  await next();
  if (c.res.status === 200) c.header("Cache-Control", cacheHeaderFor("/brand/") || "");
});
app.use("/brand/*", serveStatic({ root: UI_PUBLIC }));
app.use("/assets/*", async (c, next) => {
  await next();
  if (c.res.status === 200) c.header("Cache-Control", cacheHeaderFor("/assets/") || "");
});
app.use("/assets/*", serveStatic({ root: UI_DIST }));

function spaHtml(c: Context) {
  const host = c.req.header("host") || "";
  const action = spaIndexAction({
    feishuError: c.req.query("feishu_error") || "",
    hasSession: Boolean(getSession(getCookie(c, COOKIE))),
    displayLogin: displayLoginAllowed(host),
    oauthReady: oauthReady(),
  });
  if (action === "feishu") {
    c.header("Cache-Control", REDIRECT_CACHE);
    const next = sanitizeNext(c.req.path);
    const home = next === "/" || next === "/reviewup";
    const q = isSpaPath(next) && !home ? `?next=${encodeURIComponent(next)}` : "";
    return c.redirect(`/api/auth/feishu/login${q}`, 302);
  }
  const index = join(UI_DIST, "index.html");
  if (!existsSync(index)) {
    throw new HTTPException(503, { message: "审稿台前端未构建。请在 apps/web/ui 执行 npm run build。" });
  }
  c.header("Cache-Control", cacheHeaderFor("/") || "no-cache");
  return c.html(readFileSync(index, "utf8"));
}

function legacyToReviewup(c: Context) {
  const dest = legacyDeskRedirect(c.req.path);
  if (!dest) return spaHtml(c);
  const q = new URL(c.req.url).search;
  c.header("Cache-Control", REDIRECT_CACHE);
  return c.redirect(`${dest}${q}`, 302);
}

app.get("/", legacyToReviewup);
app.get("/new", legacyToReviewup);
app.get("/review", legacyToReviewup);
app.get("/reviewup", spaHtml);
app.get("/reviewup/new", spaHtml);
app.get("/history", spaHtml);
app.get("/settings", spaHtml);
app.get("/review/:id", spaHtml);
app.get("/mockup", spaHtml);
app.get("/mockup/new", spaHtml);
app.get("/mockup/:id", spaHtml);

export { app };

if (process.env.VITEST !== "1") {
  const pub = /^(1|true|yes)$/i.test(process.env.WB_PUBLIC || "");
  if (pub && DATA_DIR.startsWith(REPO_ROOT)) {
    throw new Error("公网模式必须把 WB_DATA_DIR 设到仓库外");
  }
  mkdirSync(join(DATA_DIR, "tasks"), { recursive: true });
  reclaimOnBoot();
  serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
    console.log(`beian-server ${VERSION} http://${info.address}:${info.port}`);
  });
}
