import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { compress } from "hono/compress";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { cacheHeaderFor, REDIRECT_CACHE } from "./cacheHeaders.js";
import { spaIndexAction } from "./spaIndex.js";
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
  maxUploadBytes,
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
  oauthReady,
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
  getJob,
  listJobsFor,
  publicMockup,
  queueMockup,
} from "./mockup.js";
import { assertIllustratorReady } from "./aiRaster.js";
import {
  activeHits,
  assertCanAccessTask,
  assertTid,
  deleteTask,
  isHitDecision,
  isReviewableStatus,
  isReworkableTask,
  listTasks,
  loadTask,
  newTid,
  nowIso,
  saveTask,
} from "./tasks.js";


type Env = { Variables: { session: Session } };

const app = new Hono<Env>();
const VERSION = "0.12.13.0";

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
    perms: s.role === "admin"
      ? ["read", "create", "decide", "complete", "delete", "export", "manage_users"]
      : ["read", "create", "decide", "complete", "delete", "export"],
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
    return c.redirect(`${publicBase()}${oauth.next || "/"}`, 302);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "登录失败";
    const code = /白名单/.test(msg) ? "forbidden" : "failed";
    return failLogin(c, code, msg);
  }
});

app.get("/api/tasks", (c) => {
  const s = need(c, "read");
  const q = c.req.query("q") || "";
  return c.json(decorateQueueAhead(listTasks(q, s.display_name, s.role === "admin")));
});

app.get("/api/tasks/:tid", (c) => {
  const s = need(c, "read");
  try {
    const task = loadTask(c.req.param("tid"));
    assertCanAccessTask(task, { name: s.display_name, admin: s.role === "admin" });
    return c.json(publicTask(task, { name: s.display_name, admin: s.role === "admin" }));
  } catch (e) {
    boom(e);
  }
});

app.delete("/api/tasks/:tid", (c) => {
  const s = need(c, "create");
  try {
    const task = loadTask(c.req.param("tid"));
    assertCanAccessTask(task, { name: s.display_name, admin: s.role === "admin" });
    deleteTask(task.id);
    return c.json({ ok: true });
  } catch (e) {
    boom(e);
  }
});

app.post("/api/tasks/upload", async (c) => {
  const s = need(c, "create");
  const body = await c.req.parseBody({ all: true });
  const product = String(body.product_name || "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 80);
  if (!product) throw new HTTPException(400, { message: "品名必填" });
  const excel = body.excel;
  const pdf = body.pdf;
  if (!(excel instanceof File) || !(pdf instanceof File)) {
    throw new HTTPException(400, { message: "需要 excel + 包装 PDF" });
  }
  const tid = newTid();
  const dir = join(DATA_DIR, "uploads", tid);
  mkdirSync(dir, { recursive: true });
  const excelPath = join(dir, "source.xlsx");
  const pdfPath = join(dir, "artwork.pdf");
  const excelBuf = Buffer.from(await excel.arrayBuffer());
  const pdfBuf = Buffer.from(await pdf.arrayBuffer());
  const limit = maxUploadBytes();
  if (excelBuf.length > limit || pdfBuf.length > limit) {
    throw new HTTPException(400, { message: `文件超过 ${Math.round(limit / 1024 / 1024)} MB` });
  }
  if (excelBuf.length < 4 || excelBuf[0] !== 0x50 || excelBuf[1] !== 0x4b) {
    throw new HTTPException(400, { message: "Excel 必须是 .xlsx（ZIP 格式）" });
  }
  if (pdfBuf.length < 5 || pdfBuf.subarray(0, 4).toString("utf8") !== "%PDF") {
    throw new HTTPException(400, { message: "不是有效的 PDF" });
  }
  writeFileSync(excelPath, excelBuf);
  writeFileSync(pdfPath, pdfBuf);
  const title = String(body.title || product);
  saveTask({
    id: tid,
    title,
    product_name: product,
    type: "excel_pdf",
    status: "comparing",
    created_at: nowIso(),
    owner: s.display_name,
    created_by: s.display_name,
    pack_surface: String(body.pack_surface || "carton"),
    job_kind: "compare",
    job_status: "queued",
  });
  try {
    enqueue({ kind: "compare", id: tid });
  } catch (err) {
    console.warn("enqueue compare failed:", err instanceof Error ? err.message : err);
  }
  return c.json(publicTask(loadTask(tid), { name: s.display_name, admin: s.role === "admin" }));
});

app.post("/api/tasks/:tid/decision", async (c) => {
  const s = need(c, "decide");
  const tid = assertTid(c.req.param("tid"));
  const body = (await c.req.json()) as { hit_id?: string; decision?: string; note?: string };
  const task = loadTask(tid);
  assertCanAccessTask(task, { name: s.display_name, admin: s.role === "admin" });
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
  return c.json(publicTask(task, { name: s.display_name, admin: s.role === "admin" }));
});

app.post("/api/tasks/:tid/complete", async (c) => {
  const s = need(c, "complete");
  const task = loadTask(c.req.param("tid"));
  assertCanAccessTask(task, { name: s.display_name, admin: s.role === "admin" });
  if (!isReviewableStatus(task.status)) {
    throw new HTTPException(400, { message: "当前状态不可签字" });
  }
  const body = (await c.req.json().catch(() => ({}))) as { conclusion?: string };
  const hits = activeHits(task);
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
  return c.json(publicTask(task, { name: s.display_name, admin: s.role === "admin" }));
});

app.post("/api/tasks/:tid/rework", async (c) => {
  const s = need(c, "create");
  const tid = assertTid(c.req.param("tid"));
  const body = await c.req.parseBody();
  const task = loadTask(tid);
  assertCanAccessTask(task, { name: s.display_name, admin: s.role === "admin" });
  if (task.job_status === "queued" || task.job_status === "running") {
    throw new HTTPException(409, { message: "对红还在排队或正在跑" });
  }
  if (!isReworkableTask(task)) {
    throw new HTTPException(400, { message: "当前状态不可对红" });
  }
  const pdf = body.pdf;
  if (!(pdf instanceof File)) throw new HTTPException(400, { message: "需要改稿后的 PDF" });
  const pdfBuf = Buffer.from(await pdf.arrayBuffer());
  const limit = maxUploadBytes();
  if (pdfBuf.length > limit) {
    throw new HTTPException(400, { message: `文件超过 ${Math.round(limit / 1024 / 1024)} MB` });
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
  return c.json(publicTask(loadTask(tid), { name: s.display_name, admin: s.role === "admin" }));
});

app.get("/api/tasks/:tid/pages/:name", (c) => {
  const s = need(c, "read");
  const tid = assertTid(c.req.param("tid"));
  assertCanAccessTask(loadTask(tid), { name: s.display_name, admin: s.role === "admin" });
  const name = c.req.param("name");
  if (!/^page_\d{2}\.png$/.test(name)) throw new HTTPException(400, { message: "非法页名" });
  const p = join(DATA_DIR, "uploads", tid, "pages", name);
  if (!existsSync(p)) throw new HTTPException(404, { message: "没有这一页" });
  return new Response(readFileSync(p), { headers: { "Content-Type": "image/png" } });
});

app.get("/api/tasks/:tid/pages/:side/:name", (c) => {
  const s = need(c, "read");
  const tid = assertTid(c.req.param("tid"));
  assertCanAccessTask(loadTask(tid), { name: s.display_name, admin: s.role === "admin" });
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
  return c.json(decorateQueueAhead(listJobsFor({ name: s.display_name, admin: s.role === "admin" }).map(publicMockup)));
});

app.post("/api/mockups", async (c) => {
  const s = need(c, "create");
  try {
    assertBlenderReady();
    assertIllustratorReady();
  } catch (e) {
    boom(e);
  }
  const body = await c.req.parseBody();
  const file = body.file || body.pdf || body.source;
  if (!(file instanceof File)) throw new HTTPException(400, { message: "需要 .ai 稿件" });
  if (!/\.ai$/i.test(file.name)) {
    throw new HTTPException(400, { message: "只收 .ai 稿件。" });
  }
  const id = newTid();
  const dir = join(DATA_DIR, "mockups", id);
  mkdirSync(dir, { recursive: true });
  const src = join(dir, file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "art.ai");
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > maxUploadBytes()) {
    throw new HTTPException(400, { message: `文件超过 ${Math.round(maxUploadBytes() / 1024 / 1024)} MB` });
  }
  writeFileSync(src, buf);
  const title = String(body.title || body.product_name || "").trim();
  const job = queueMockup({ id, sourcePath: src, displayName: s.display_name, title });
  try {
    enqueue({ kind: "mockup", id });
  } catch (err) {
    console.warn("enqueue mockup failed:", err instanceof Error ? err.message : err);
  }
  return c.json(decorateQueueAhead([publicMockup(getJob(id) || job)])[0]);
});

app.get("/api/mockups/:id", (c) => {
  const s = need(c, "read");
  const job = getJob(assertTid(c.req.param("id")));
  if (!job) throw new HTTPException(404, { message: "没有这单打样" });
  assertCanAccessMockup(job, { name: s.display_name, admin: s.role === "admin" });
  return c.json(decorateQueueAhead([publicMockup(job)])[0]);
});

app.delete("/api/mockups/:id", (c) => {
  const s = need(c, "create");
  try {
    const job = getJob(assertTid(c.req.param("id")));
    if (!job) throw new HTTPException(404, { message: "没有这单打样" });
    assertCanAccessMockup(job, { name: s.display_name, admin: s.role === "admin" });
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
  assertCanAccessMockup(job, { name: s.display_name, admin: s.role === "admin" });
  const f = fileOf(job, c.req.param("key"));
  if (!f?.path || !existsSync(f.path)) throw new HTTPException(404, { message: "文件还没有" });
  const type = f.name.endsWith(".glb")
    ? "model/gltf-binary"
    : f.name.endsWith(".png")
      ? "image/png"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return new Response(readFileSync(f.path), {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${f.name}"`,
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

app.get("/", (c) => {
  const host = c.req.header("host") || "";
  const action = spaIndexAction({
    feishuError: c.req.query("feishu_error") || "",
    hasSession: Boolean(getSession(getCookie(c, COOKIE))),
    displayLogin: displayLoginAllowed(host),
    oauthReady: oauthReady(),
  });
  if (action === "feishu") {
    c.header("Cache-Control", REDIRECT_CACHE);
    return c.redirect("/api/auth/feishu/login", 302);
  }
  const index = join(UI_DIST, "index.html");
  if (!existsSync(index)) {
    throw new HTTPException(503, { message: "审稿台前端未构建。请在 apps/web/ui 执行 npm run build。" });
  }
  c.header("Cache-Control", cacheHeaderFor("/") || "no-cache");
  return c.html(readFileSync(index, "utf8"));
});

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
