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
import { serve, type Http2Bindings, type HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { cacheHeaderFor, REDIRECT_CACHE } from "./cacheHeaders.js";
import {
  createReleaseCoordinator,
  isReleaseProtectedRequest,
  releaseReadiness,
  RELEASE_CONTROL_PROTOCOL,
  RELEASE_CONTROL_TEST_TOKEN,
} from "./releaseAdmission.js";
import { isSpaPath, legacyDeskRedirect, spaIndexAction } from "./spaIndex.js";
import { COOKIE, DATA_DIR, HOST, PORT, REPO_ROOT, UI_DIST, UI_PUBLIC, cookieSecure } from "./config.js";
import { billingSnapshot, loadVendorBills, resetBillingCache } from "./billing.js";
import { notifyTaskComplete, sendText } from "./notify.js";
import {
  decorateQueueAhead,
  enqueue,
  launchNotification,
  notificationSnapshot,
  publicTask,
  queueSnapshot,
  reclaimOnBoot,
} from "./jobs.js";
import {
  feishuRedirect,
  getSetting,
  publicBase,
  publicView,
  runProbe,
  saveSettings,
} from "./settings.js";
import { scanLocalApps } from "./scanLocal.js";
import {
  AuthBoundaryError,
  authorizeUrl,
  beginOAuth,
  consumeOAuth,
  createDisplaySession,
  displayLoginAllowed,
  exchangeCode,
  getSession,
  isLoopbackHost,
  loginFailureCode,
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
  acceptStructureConfirmation,
  assertCanManageMockup,
  beginStructureConfirmation,
  deleteMockup,
  fileOf,
  findMockupBySourceReceipt,
  getJob,
  isMockupJobFile,
  isStructureProposalId,
  isWhiteFile,
  mockupFileBrokenMessage,
  listJobs,
  publicMockup,
  publicMockupSummary,
  prepareStructureConfirmation,
  prepareStructureInputSelection,
  queueMockup,
  finishStructureConfirmation,
  structureConfirmationFailureStatus,
  type StructureAnchorDecision,
  type StructureConfirmationDecision,
} from "./mockup.js";
import { assertIllustratorReady } from "./aiRaster.js";
import {
  assertIllustratorAgentReady,
  publicIllustratorAgentStatus,
  readIllustratorAgentStatus,
} from "./illustratorAgent.js";
import { confirmPackagingStructure } from "./workers.js";
import { skipPackSheetField } from "./sheetSkip.js";
import {
  appendUploadChunk,
  claimReceipt,
  commitReceiptClaim,
  completeUploadSession,
  createUploadAdmission,
  createUploadCoordinator,
  discardPendingUpload,
  discardReceipt,
  listPendingUploads,
  loadReceipt,
  MAX_UPLOAD_BODY_BYTES,
  recoverReceiptClaims,
  receiptOwner,
  rollbackReceiptClaim,
  serializeReceiptStart,
  stageMultipart,
  tooLarge,
  underReceiptDir,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_SESSION_METADATA_BYTES,
  UPLOAD_BODY_TOO_LARGE,
  UPLOAD_RECEIPT_EXPIRED_CODE,
  oversizeMessage,
  uploadTotalTooLarge,
} from "./uploads.js";
import {
  activeHits,
  assertCanAccessTask,
  assertTid,
  deleteTask,
  findTaskBySourceReceipt,
  hitNeedsDecision,
  isHitDecision,
  isReviewableStatus,
  isReworkableTask,
  isValidHitReviewState,
  listTasks,
  loadTask,
  newTid,
  nowIso,
  saveTask,
  viewerFromSession,
} from "./tasks.js";


type NodeBindings = HttpBindings | Http2Bindings;
type Env = { Bindings: NodeBindings; Variables: { session: Session } };

const app = new Hono<Env>();
const VERSION = "0.21.15.0";
const STRUCTURE_INPUT_BODY_BYTES = 16 * 1024;

class ApiProblem extends Error {
  constructor(
    readonly status: 400 | 409 | 422 | 500,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function expiredUpload(): ApiProblem {
  return new ApiProblem(400, UPLOAD_RECEIPT_EXPIRED_CODE, "上传已过期，请重新传文件");
}
/** 浏览器给 100 MB 慢速上传 15 分钟；服务端多留 1 分钟完成落盘和回执。 */
export const SERVER_HTTP_OPTIONS = {
  headersTimeout: 60_000,
  requestTimeout: 16 * 60 * 1000,
} as const;
const uploadCoordinator = createUploadCoordinator();
// 对红仍用 Hono parseBody，单独保持单槽；新稿上传已改为双通道流式落盘。
const reworkUploadAdmission = createUploadAdmission(1);
const releaseControlPath = join(DATA_DIR, "runtime", "release-control.json");
const releaseDrainFencePath = join(DATA_DIR, "runtime", "release-drain.json");
const releaseCoordinator = createReleaseCoordinator(
  process.env.VITEST === "1" ? RELEASE_CONTROL_TEST_TOKEN : undefined,
  { fencePath: releaseDrainFencePath },
);

app.use("*", async (c, next) => {
  const protectedRequest = isReleaseProtectedRequest(c.req.method, c.req.path);
  if (c.req.path.startsWith("/api/") && protectedRequest) {
    // ReleaseCoordinator 在 app.fetch 外层先登记请求，因此 getSession 的
    // 过期清理和角色落盘也完整处于排空生命周期内。
    const cookie = getCookie(c, COOKIE);
    const tok = c.req.header("authorization") || (cookie ? `Bearer ${cookie}` : "");
    const sess = getSession(tok, c.req.header("host") || "");
    if (sess) c.set("session", sess);
  }
  await next();
});

// 压缩属于应用内部实现；发布生命周期由外层 Node ServerResponse 决定。
app.use(compress());

function need(
  c: { get: (k: "session") => Session | undefined },
  perm: string,
  deniedMessage = "没有权限",
): Session {
  const s = c.get("session");
  if (!s) throw new HTTPException(401, { message: "未登录" });
  if (!hasPerm(s.role as Role, perm)) throw new HTTPException(403, { message: deniedMessage });
  return s;
}

function safeLogCause(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/((?:token|secret|api[_-]?key|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, "$1***")
    .slice(0, 240);
}

function finalJsonObject(text: string): Record<string, unknown> | null {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      /* next line */
    }
  }
  return null;
}

function boom(err: unknown): never {
  const status = typeof err === "object" && err && "status" in err ? Number((err as { status: number }).status) : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AuthBoundaryError) {
    throw new HTTPException(err.status as 403, { message: err.message });
  }
  if (status >= 400 && status < 500) throw new HTTPException(status as 400, { message });
  console.error(`request failed: problem=业务请求异常 cause=${safeLogCause(err)} fix=查看服务端日志定位`);
  throw new HTTPException(500, { message: "服务器错误" });
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
  if (err instanceof ApiProblem) {
    return c.json({ detail: err.message, code: err.code }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ detail: err.message }, err.status);
  }
  const status = typeof err === "object" && err && "status" in err ? Number((err as { status: number }).status) : 500;
  const message = err instanceof Error ? err.message : "服务器错误";
  if (status >= 400 && status < 500) return c.json({ detail: message }, status as 400);
  console.error(`request failed: problem=未处理异常 cause=${safeLogCause(err)} fix=查看堆栈与对应任务文件`);
  return c.json({ detail: "服务器错误" }, 500);
});

function liveStatus(includeAgentDiagnostics = false) {
  const primaryUploads = uploadCoordinator.snapshot();
  const reworkUploads = reworkUploadAdmission.snapshot();
  const jobs = queueSnapshot();
  const agent = readIllustratorAgentStatus();
  return {
    jobs: {
      ...jobs,
      illustrator: {
        ...jobs.illustrator,
        agent: includeAgentDiagnostics ? agent : publicIllustratorAgentStatus(agent),
      },
    },
    uploads: {
      active: primaryUploads.active + reworkUploads.active,
      waiting: primaryUploads.waiting + reworkUploads.waiting,
    },
    feishu_notify:
      /^(1|true|yes|on)$/i.test(getSetting("FEISHU_ENABLED")) && Boolean(getSetting("FEISHU_OPEN_ID")),
  };
}

function isDirectLoopbackHealth(c: Context): boolean {
  // 杭州 release.ps1 直连 127.0.0.1，需要准确队列来阻止带任务升版。
  // Named Tunnel 会保留公网 Host/转发头；公网匿名探测不触发同步任务扫盘。
  const forwarded = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for");
  return !forwarded && isLoopbackHost(c.req.header("host") || "");
}

function releaseControlToken(c: Context): string {
  return c.req.header("x-beian-release-token") || "";
}

function releaseControlLease(c: Context): string {
  return c.req.header("x-beian-release-lease") || "";
}

function releaseControlPayload(admission: ReturnType<typeof releaseCoordinator.snapshot>) {
  const jobs = queueSnapshot();
  const primaryUploads = uploadCoordinator.snapshot();
  const reworkUploads = reworkUploadAdmission.snapshot();
  const readiness = releaseReadiness({
    admission,
    jobs: [jobs.ocr, jobs.blender, jobs.illustrator],
    jobsUnknown: jobs.unknown,
    uploads: {
      active: primaryUploads.active + reworkUploads.active,
      waiting: primaryUploads.waiting + reworkUploads.waiting,
    },
    notifications: notificationSnapshot(),
    illustratorState: readIllustratorAgentStatus().state,
  });
  return {
    ok: true,
    protocol: RELEASE_CONTROL_PROTOCOL,
    instance_id: releaseCoordinator.instanceId,
    version: VERSION,
    pid: process.pid,
    ...admission,
    ...readiness,
  };
}

app.get("/api/internal/release/identity", (c) => {
  try {
    const instanceId = releaseCoordinator.identity(releaseControlToken(c));
    return c.json({
      ok: true,
      protocol: RELEASE_CONTROL_PROTOCOL,
      instance_id: instanceId,
      version: VERSION,
      pid: process.pid,
    });
  } catch (err) {
    boom(err);
  }
});

app.post("/api/internal/release/drain", (c) => {
  try {
    return c.json(releaseControlPayload(
      releaseCoordinator.enter(releaseControlToken(c), releaseControlLease(c)),
    ));
  } catch (err) {
    boom(err);
  }
});

app.put("/api/internal/release/drain", (c) => {
  try {
    return c.json(releaseControlPayload(
      releaseCoordinator.promote(releaseControlToken(c), releaseControlLease(c)),
    ));
  } catch (err) {
    boom(err);
  }
});

app.get("/api/internal/release/drain", (c) => {
  try {
    return c.json(releaseControlPayload(
      releaseCoordinator.inspect(releaseControlToken(c), releaseControlLease(c)),
    ));
  } catch (err) {
    boom(err);
  }
});

app.delete("/api/internal/release/drain", (c) => {
  try {
    return c.json(releaseControlPayload(
      releaseCoordinator.leave(releaseControlToken(c), releaseControlLease(c)),
    ));
  } catch (err) {
    boom(err);
  }
});

app.get("/api/health", (c) => {
  const base = { ok: true, version: VERSION, runtime: "typescript" };
  if (isDirectLoopbackHealth(c)) return c.json({ ...base, ...liveStatus(true) });
  return c.json({
    ...base,
    // 公网发版核对保留 jobs.illustrator 存在性合同，但不公开作业数量。
    jobs: { illustrator: { visibility: "authenticated" } },
  });
});

app.get("/api/status", (c) => {
  const session = need(c, "read");
  return c.json({
    ok: true,
    version: VERSION,
    runtime: "typescript",
    ...liveStatus(session.role === "admin"),
  });
});

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
    return failLogin(c, loginFailureCode(e), msg);
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
    const tid = assertTid(c.req.param("tid"));
    let task: ReturnType<typeof loadTask>;
    try {
      task = loadTask(tid);
    } catch (err) {
      if (typeof err === "object" && err && "status" in err && Number((err as { status: number }).status) === 404) {
        return c.json({ ok: true, already_deleted: true });
      }
      throw err;
    }
    assertCanAccessTask(task, viewerFromSession(s));
    deleteTask(task.id);
    return c.json({ ok: true });
  } catch (e) {
    boom(e);
  }
});

app.get("/api/uploads", (c) => {
  const s = need(c, "create");
  return c.json(listPendingUploads(receiptOwner(s)));
});

app.delete("/api/uploads/:id", (c) => {
  const s = need(c, "create");
  const removed = discardPendingUpload(c.req.param("id"), receiptOwner(s));
  return c.json({ ok: true, ...(removed ? {} : { already_deleted: true }) });
});

app.post(
  "/api/uploads/sessions",
  bodyLimit({
    maxSize: UPLOAD_SESSION_METADATA_BYTES,
    onError: (c) => c.json({ detail: "上传文件信息过大" }, 413),
  }),
  async (c) => {
    const s = need(c, "create");
    try {
      const body = await c.req.json();
      return c.json({ upload: uploadCoordinator.start(receiptOwner(s), body) });
    } catch (err) {
      boom(err);
    }
  },
);

app.put(
  "/api/uploads/sessions/:id/files/:field",
  async (c, next) => {
    need(c, "create");
    await uploadCoordinator.runSession(c.req.param("id"), next);
  },
  bodyLimit({
    maxSize: UPLOAD_CHUNK_BYTES,
    onError: (c) => c.json({ detail: "上传分片超过 1 MB" }, 413),
  }),
  async (c) => {
    const s = need(c, "create");
    try {
      const chunk = Buffer.from(await c.req.arrayBuffer());
      const offset = Number(c.req.header("x-upload-offset") || "NaN");
      const sha256 = c.req.header("x-upload-sha256") || "";
      const upload = appendUploadChunk(
        c.req.param("id"),
        receiptOwner(s),
        c.req.param("field"),
        offset,
        chunk,
        sha256,
      );
      return c.json({ upload });
    } catch (err) {
      boom(err);
    }
  },
);

app.post("/api/uploads/sessions/:id/complete", async (c) => {
  const s = need(c, "create");
  try {
    const upload = await uploadCoordinator.runSession(c.req.param("id"), async () =>
      completeUploadSession(c.req.param("id"), receiptOwner(s)),
    );
    return c.json({ upload });
  } catch (err) {
    boom(err);
  }
});

app.post(
  "/api/uploads",
  async (c, next) => {
    need(c, "create");
    await uploadCoordinator.runLegacy(next);
  },
  async (c) => {
    const s = need(c, "create");
    const declaredBytes = Number(c.req.header("content-length") || "0");
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_UPLOAD_BODY_BYTES) {
      throw new HTTPException(413, { message: UPLOAD_BODY_TOO_LARGE });
    }
    const body = c.req.raw.body;
    if (!body) throw new HTTPException(400, { message: "没有文件" });
    try {
      const rec = await stageMultipart(
        receiptOwner(s),
        body as unknown as AsyncIterable<Uint8Array>,
        c.req.header("content-type") || "",
      );
      return c.json({
        receipt: rec.id,
        client_upload_id: rec.client_upload_id,
        files: rec.files.map((f) => ({ field: f.field, name: f.name, bytes: f.bytes })),
      });
    } catch (err) {
      boom(err);
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
  return serializeReceiptStart(receiptId, owner, async () => {
    const existing = findTaskBySourceReceipt(receiptId, owner);
    if (existing) {
      discardReceipt(receiptId, owner);
      return c.json(publicTask(existing, viewerFromSession(s)));
    }
    const peeked = loadReceipt(receiptId, owner);
    if (!peeked) throw expiredUpload();
    if (!peeked.files.some((f) => f.field === "excel") || !peeked.files.some((f) => f.field === "pdf")) {
      throw new HTTPException(400, { message: "需要 excel + 包装 PDF" });
    }
    const claim = claimReceipt(receiptId, owner);
    if (!claim) {
      const recovered = findTaskBySourceReceipt(receiptId, owner);
      if (recovered) return c.json(publicTask(recovered, viewerFromSession(s)));
      throw expiredUpload();
    }
    const rec = claim.receipt;
    const excel = rec.files.find((f) => f.field === "excel");
    const pdf = rec.files.find((f) => f.field === "pdf");
    if (!excel || !pdf || !underReceiptDir(rec.id, excel.path) || !underReceiptDir(rec.id, pdf.path)) {
      commitReceiptClaim(claim);
      throw expiredUpload();
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
      const restored = rollbackReceiptClaim(claim);
      console.error("create compare task failed", {
        problem: "上传回执已领取，但审核单文件没有准备完成",
        cause: err instanceof Error ? err.message : String(err),
        fix: restored ? "回执已恢复，可重新开始对照" : "领取标记仍在，服务下次启动会恢复回执",
      });
      throw new HTTPException(500, {
        message: restored ? "创建审核单失败，请再点一次开始对照" : "创建审核单失败，上传暂存仍保留，请联系管理员恢复后重试",
      });
    }
    if (!commitReceiptClaim(claim)) {
      console.warn("commit compare receipt claim deferred", {
        problem: "审核单已落盘，但上传回执领取标记暂未清理",
        cause: receiptId,
        fix: "服务下次启动会按 source_receipt 完成清理",
      });
    }
    try {
      enqueue({ kind: "compare", id: tid });
    } catch (err) {
      console.warn("enqueue compare failed:", err instanceof Error ? err.message : err);
    }
    return c.json(publicTask(loadTask(tid), viewerFromSession(s)));
  });
});

app.post("/api/mockups/start", async (c) => {
  const s = need(c, "create");
  const body = (await c.req.json()) as { receipt?: string; title?: string; product_name?: string };
  const owner = receiptOwner(s);
  const receiptId = String(body.receipt || "");
  return serializeReceiptStart(receiptId, owner, async () => {
    const existing = findMockupBySourceReceipt(receiptId, owner);
    if (existing) {
      discardReceipt(receiptId, owner);
      return c.json(decorateQueueAhead([publicMockup(existing)])[0]);
    }
    let illustratorExecutable: string;
    try {
      assertBlenderReady();
      illustratorExecutable = assertIllustratorReady();
      assertIllustratorAgentReady();
    } catch (e) {
      boom(e);
    }
    const peeked = loadReceipt(receiptId, owner);
    if (!peeked) throw expiredUpload();
    if (!peeked.files.some((f) => f.field === "ai")) throw new HTTPException(400, { message: "需要 .ai 稿件" });
    const claim = claimReceipt(receiptId, owner);
    if (!claim) {
      const recovered = findMockupBySourceReceipt(receiptId, owner);
      if (recovered) return c.json(decorateQueueAhead([publicMockup(recovered)])[0]);
      throw expiredUpload();
    }
    const rec = claim.receipt;
    const ai = rec.files.find((f) => f.field === "ai");
    if (!ai || !underReceiptDir(rec.id, ai.path)) {
      commitReceiptClaim(claim);
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
        illustratorExecutable,
        title,
      });
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      const restored = rollbackReceiptClaim(claim);
      console.error("create mockup task failed", {
        problem: "上传回执已领取，但打样单文件没有准备完成",
        cause: err instanceof Error ? err.message : String(err),
        fix: restored ? "回执已恢复，可重新开始打样" : "领取标记仍在，服务下次启动会恢复回执",
      });
      throw new HTTPException(500, {
        message: restored ? "创建打样单失败，请再点一次开始打样" : "创建打样单失败，上传暂存仍保留，请联系管理员恢复后重试",
      });
    }
    if (!commitReceiptClaim(claim)) {
      console.warn("commit mockup receipt claim deferred", {
        problem: "打样单已落盘，但上传回执领取标记暂未清理",
        cause: receiptId,
        fix: "服务下次启动会按 source_receipt 完成清理",
      });
    }
    try {
      enqueue({ kind: "mockup", id });
    } catch (err) {
      console.warn("enqueue mockup failed:", err instanceof Error ? err.message : err);
    }
    return c.json(decorateQueueAhead([publicMockup(getJob(id) || job)])[0]);
  });
});

app.post(
  "/api/mockups/:id/structure/input",
  async (c, next) => {
    need(c, "confirm_structure", "当前账号不能选择包装结构层");
    await next();
  },
  bodyLimit({
    maxSize: STRUCTURE_INPUT_BODY_BYTES,
    onError: (c) => c.json({
      code: "packaging_structure_selection_too_large",
      detail: "结构层选择请求过大",
    }, 413),
  }),
  async (c) => {
    const id = assertTid(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { candidate_ids?: unknown };
    const candidateIds = body.candidate_ids;
    if (
      !Array.isArray(candidateIds)
      || candidateIds.length < 1
      || candidateIds.length > 16
      || candidateIds.some((value) => typeof value !== "string" || !/^proposal-layer-[0-9a-f]{16}$/.test(value))
      || new Set(candidateIds).size !== candidateIds.length
    ) {
      throw new ApiProblem(
        400,
        "packaging_structure_selection_invalid",
        "请选择 1–16 个当前稿件列出的结构图层",
      );
    }
    const job = getJob(id);
    if (!job) throw new HTTPException(404, { message: "没有这单打样" });
    const currentSelection = job.structure_input_selection_ids;
    const sameSelection = Array.isArray(currentSelection)
      && currentSelection.length === candidateIds.length
      && currentSelection.every((value) => candidateIds.includes(value));
    if (job.structure_status !== "review_required" || job.job_status !== "waiting_input") {
      if (sameSelection) return c.json(decorateQueueAhead([publicMockup(job)])[0]);
      throw new ApiProblem(
        409,
        "packaging_structure_selection_stale",
        "这单当前没有待选择的包装结构层",
      );
    }
    beginStructureConfirmation(job);
    try {
      let selection: ReturnType<typeof prepareStructureInputSelection>;
      try {
        selection = prepareStructureInputSelection(job, candidateIds);
      } catch (error) {
        const status = Number((error as { status?: number }).status);
        if (status === 400 || status === 409) {
          throw new ApiProblem(
            status,
            status === 400 ? "packaging_structure_selection_invalid" : "packaging_structure_selection_stale",
            status === 400
              ? "请选择当前稿件列出的结构图层"
              : "结构层选择已失效，请刷新后重试",
          );
        }
        console.error("prepare packaging structure input failed", {
          problem: "已登录账号已提交候选结构层，但源稿绑定清单没有安全写成",
          cause: safeLogCause(error),
          fix: "保留待选择状态，检查任务目录后原位重试",
        });
        throw new ApiProblem(
          500,
          "packaging_structure_selection_failed",
          "结构层处理失败，请稍后重试",
        );
      }
      if (selection.changed) {
        try {
          enqueue({ kind: "mockup", id });
        } catch (error) {
          console.warn("enqueue selected structure input failed:", error instanceof Error ? error.message : error);
        }
      }
      return c.json(decorateQueueAhead([publicMockup(getJob(id) || selection.job)])[0]);
    } finally {
      finishStructureConfirmation(id);
    }
  },
);

app.post("/api/mockups/:id/structure", async (c) => {
  need(c, "confirm_structure", "当前账号不能确认包装结构");
  const id = assertTid(c.req.param("id"));
  const job = getJob(id);
  if (!job) throw new HTTPException(404, { message: "没有这单打样" });
  if (job.structure_status === "ready") {
    // 首次确认可能已经落盘，只是响应在 Tunnel / 浏览器链路丢失。重复提交应
    // 收敛到同一打样单，不能让用户误以为确认失败或再次执行结构 worker。
    return c.json(decorateQueueAhead([publicMockup(job)])[0]);
  }
  if (job.structure_status !== "review_required" || job.job_status !== "waiting_input") {
    throw new HTTPException(409, { message: "这单当前没有待确认的包装结构" });
  }
  const body = (await c.req.json().catch(() => ({}))) as { anchor?: unknown };
  if (!body.anchor || typeof body.anchor !== "object" || Array.isArray(body.anchor)) {
    throw new HTTPException(400, { message: "请选择完整盒型和正面" });
  }
  const value = body.anchor as Record<string, unknown>;
  const proposalId = String(value.proposal_id || "");
  const frontFaceId = String(value.front_face_id || "");
  const turns = value.quarter_turns ?? 0;
  if (
    !isStructureProposalId(proposalId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(frontFaceId) ||
    typeof turns !== "number" ||
    !Number.isInteger(turns) ||
    turns < 0 ||
    turns > 3
  ) {
    throw new HTTPException(400, { message: "完整盒型、正面或方向不对" });
  }
  const decision: StructureConfirmationDecision = {
    anchor: {
      proposal_id: proposalId,
      front_face_id: frontFaceId,
      quarter_turns: turns as StructureAnchorDecision["quarter_turns"],
    },
  };
  beginStructureConfirmation(job);
  try {
    const files = prepareStructureConfirmation(job, decision);
    const result = await confirmPackagingStructure(files);
    if (result.timedOut) throw new HTTPException(504, { message: "结构确认超时，请再试一次" });
    const output = finalJsonObject(result.stdout);
    if (result.code !== 0 || output?.ok !== true || typeof output.sidecar !== "string") {
      const failure = finalJsonObject(result.stderr);
      const code = typeof failure?.code === "string" ? failure.code : `worker_exit_${result.code}`;
      const status = structureConfirmationFailureStatus(code);
      const message = typeof failure?.message === "string"
        ? failure.message.slice(0, 120)
        : status === 500
          ? "结构确认服务异常，请稍后重试"
          : "结构确认不能形成闭合盒";
      const logContext = status === 500
        ? {
            problem: "结构确认 worker 未返回受支持的业务结果",
            cause: code,
            fix: "检查 worker 退出、运行依赖和最后一行 JSON；保留待确认状态",
          }
        : {
            problem: "管理员提交了完整盒型锚点，但 V2 resolver 没有接受",
            cause: code,
            fix: "保留待确认状态，调整盒型、正面或方向后重试",
          };
      if (status === 500) console.error("confirm packaging structure failed", logContext);
      else console.warn("confirm packaging structure failed", logContext);
      throw new ApiProblem(status, code, message);
    }
    const fresh = getJob(id);
    if (!fresh) throw new HTTPException(404, { message: "打样单已删除" });
    if (
      fresh.structure_status !== "review_required" ||
      fresh.structure_resolution_path !== job.structure_resolution_path ||
      fresh.structure_source_sha256 !== job.structure_source_sha256
    ) {
      if (fresh.structure_status === "ready") {
        return c.json(decorateQueueAhead([publicMockup(fresh)])[0]);
      }
      throw new HTTPException(409, { message: "源稿或结构状态已变化，请刷新后再确认" });
    }
    acceptStructureConfirmation(fresh, output.sidecar);
    try {
      enqueue({ kind: "mockup", id });
    } catch (error) {
      console.warn("enqueue confirmed mockup failed:", error instanceof Error ? error.message : error);
    }
    return c.json(decorateQueueAhead([publicMockup(getJob(id) || fresh)])[0]);
  } finally {
    finishStructureConfirmation(id);
  }
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
  const tid = assertTid(c.req.param("tid"));
  const body = (await c.req.json().catch(() => ({}))) as { conclusion?: string };
  // json() 会让出事件循环；另一标签可能已经开始对红或新一轮对照。
  // 最后一次 await 后再读盘，此后同步落盘，旧对象不能覆盖新的作业状态。
  const task = loadTask(tid);
  assertCanAccessTask(task, viewerFromSession(s));
  if (task.job_status === "queued" || task.job_status === "running") {
    throw new HTTPException(409, { message: "对照还在排队或正在跑，不能签字" });
  }
  if (!isReviewableStatus(task.status)) {
    throw new HTTPException(400, { message: "当前状态不可签字" });
  }
  const hits = activeHits(task).filter((h) => !skipPackSheetField(h.field));
  const invalid = hits.filter((h) => !isValidHitReviewState(h));
  if (invalid.length) {
    throw new HTTPException(400, { message: `有 ${invalid.length} 条审核数据状态异常，请重新对照` });
  }
  const pending = hits.filter(hitNeedsDecision);
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
  launchNotification(`signed task ${task.id}`, () => notifyTaskComplete(task, s.display_name));
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
    await reworkUploadAdmission.run(next);
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
  if (!/^page_\d{2}\.(?:png|svg)$/.test(name)) throw new HTTPException(400, { message: "非法页名" });
  const p = join(DATA_DIR, "uploads", tid, "pages", name);
  if (!existsSync(p)) throw new HTTPException(404, { message: "没有这一页" });
  const svg = name.endsWith(".svg");
  return new Response(readFileSync(p), {
    headers: svg
      ? {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
          "X-Content-Type-Options": "nosniff",
        }
      : { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" },
  });
});

app.get("/api/tasks/:tid/pages/:side/:name", (c) => {
  const s = need(c, "read");
  const tid = assertTid(c.req.param("tid"));
  assertCanAccessTask(loadTask(tid), viewerFromSession(s));
  const side = c.req.param("side");
  const name = c.req.param("name");
  if (!/^[a-z0-9]+$/i.test(side) || !/^page_\d{2}\.(?:png|svg)$/.test(name)) {
    throw new HTTPException(400, { message: "非法路径" });
  }
  const p = join(DATA_DIR, "uploads", tid, "pages", side, name);
  if (!existsSync(p)) throw new HTTPException(404, { message: "没有这一页" });
  const svg = name.endsWith(".svg");
  return new Response(readFileSync(p), {
    headers: svg
      ? {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
          "X-Content-Type-Options": "nosniff",
        }
      : { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" },
  });
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
  const s = need(c, "read");
  if (s.role !== "admin") {
    throw new HTTPException(403, { message: "改系统配置需要管理员" });
  }
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
  need(c, "read");
  return c.json(decorateQueueAhead(listJobs().map(publicMockupSummary)));
});

app.get("/api/mockups/:id", (c) => {
  need(c, "read");
  const job = getJob(assertTid(c.req.param("id")));
  if (!job) throw new HTTPException(404, { message: "没有这单打样" });
  return c.json(decorateQueueAhead([publicMockup(job)])[0]);
});

app.delete("/api/mockups/:id", (c) => {
  const s = need(c, "delete");
  try {
    const id = assertTid(c.req.param("id"));
    const job = getJob(id);
    if (!job) return c.json({ ok: true, already_deleted: true });
    assertCanManageMockup(job, viewerFromSession(s));
    deleteMockup(job.id);
    return c.json({ ok: true });
  } catch (e) {
    boom(e);
  }
});

app.get("/api/mockups/:id/files/:key", (c) => {
  need(c, "read");
  const job = getJob(assertTid(c.req.param("id")));
  if (!job) throw new HTTPException(404, { message: "没有这单打样" });
  const key = c.req.param("key");
  const f = fileOf(job, key);
  if (!f?.path || !existsSync(f.path)) throw new HTTPException(404, { message: "文件还没有" });
  if (!isWhiteFile(key, f.name)) {
    throw new HTTPException(415, { message: mockupFileBrokenMessage(key) });
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
    throw new HTTPException(415, { message: mockupFileBrokenMessage(key) });
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

app.get("/api/mockups/:id/structure-preview", (c) => {
  need(c, "read");
  const job = getJob(assertTid(c.req.param("id")));
  if (!job) throw new HTTPException(404, { message: "没有这单打样" });
  const path = job.structure_artwork_preview_path;
  if (!isMockupJobFile(job.id, path) || !pngMagicAt(path)) {
    throw new HTTPException(404, { message: "结构原稿预览还没有" });
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: {
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
    },
  });
});

app.get("/api/mockups/:id/structure-input-preview", (c) => {
  need(c, "read");
  const job = getJob(assertTid(c.req.param("id")));
  if (!job) throw new HTTPException(404, { message: "没有这单打样" });
  const path = job.structure_input_preview_path || job.structure_artwork_preview_path;
  if (!isMockupJobFile(job.id, path) || !pngMagicAt(path)) {
    throw new HTTPException(404, { message: "结构层原稿预览还没有" });
  }
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: {
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
    },
  });
});

export function faviconResponse(path: string): Response {
  if (!pngMagicAt(path)) throw new HTTPException(404, { message: "站点图标不存在" });
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: {
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": cacheHeaderFor("/brand/logo-mark.png") || "public, max-age=86400",
    },
  });
}

app.get("/favicon.ico", () => {
  return faviconResponse(join(UI_PUBLIC, "brand", "logo-mark.png"));
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
    hasSession: Boolean(getSession(getCookie(c, COOKIE), host)),
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

export function releaseFetch(request: Request, bindings: NodeBindings): Promise<Response> {
  return releaseCoordinator.handle(
    request,
    bindings,
    (nextRequest, nextBindings) => app.fetch(nextRequest, nextBindings),
  );
}

if (process.env.VITEST !== "1") {
  const pub = /^(1|true|yes)$/i.test(process.env.WB_PUBLIC || "");
  if (pub && DATA_DIR.startsWith(REPO_ROOT)) {
    throw new Error("公网模式必须把 WB_DATA_DIR 设到仓库外");
  }
  mkdirSync(join(DATA_DIR, "tasks"), { recursive: true });
  releaseCoordinator.controlFile(releaseControlPath, VERSION);
  const recoveredReceipts = recoverReceiptClaims((receipt) =>
    Boolean(
      findTaskBySourceReceipt(receipt.id, receipt.owner) ||
        findMockupBySourceReceipt(receipt.id, receipt.owner),
    ),
  );
  if (Object.values(recoveredReceipts).some((count) => count > 0)) {
    console.info("recovered upload receipt claims", recoveredReceipts);
  }
  reclaimOnBoot();
  serve({ fetch: releaseFetch, hostname: HOST, port: PORT, serverOptions: SERVER_HTTP_OPTIONS }, (info) => {
    console.log(`beian-server ${VERSION} http://${info.address}:${info.port}`);
  });
}
