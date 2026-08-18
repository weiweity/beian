/**
 * 备案审核工作台 · 前端
 * 双图对比 · 缩放全屏 · 字号密度 · 侧栏折叠
 */
const API = "";
const TOKEN_KEY = "wb_token";
const NAME_KEY = "wb_name";
const DENSITY_KEY = "wb_density";
const SIDEBAR_KEY = "wb_sidebar";
/** 与后端 text_verify.ENGINE_VERSION 对齐 */
const TVT_ENGINE_MIN = "tvt-lite-1.11";

let currentTask = null;
let filter = "todo";
let pageIdx = 0;
let selectedHitId = null;
let sideAB = "a";
let viewMode = "single"; // single | compare
let session = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  name: localStorage.getItem(NAME_KEY) || "",
  role: localStorage.getItem("wb_role") || "",
  perms: [],
};

function can(perm) {
  if (!session.perms || !session.perms.length) {
    // 未登录时：本地试用默认当 reviewer（与后端未强制 known 一致）
    if (!session.token) return !["backup", "manage_users"].includes(perm);
    return false;
  }
  return session.perms.includes(perm);
}

let wizType = "excel_pdf";
let wizFiles = { excel: null, pdf: null, pdf_a: null, pdf_b: null };
/** excel_pdf：carton=花盒 | pouch=膜袋（二选一） */
let wizPackSurface = "carton";
let wizStep = 1;
const MAX_UPLOAD_MB_UI = 200;
/** 当前打开的图元信息，供 focus 用 */
let openMeta = { a: null, b: null, s: null };

const $ = (id) => document.getElementById(id);

function applyDensity(d) {
  document.documentElement.setAttribute("data-density", d === "large" ? "large" : "std");
  localStorage.setItem(DENSITY_KEY, d === "large" ? "large" : "std");
  document.querySelectorAll(".density-chip").forEach((c) => {
    c.classList.toggle("on", c.dataset.density === (d === "large" ? "large" : "std"));
  });
}
function applySidebar(collapsed) {
  $("appRoot")?.classList.toggle("sidebar-collapsed", !!collapsed);
  localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  const btn = $("btnSidebarToggle");
  if (btn) btn.textContent = collapsed ? "»" : "«";
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function loading(on, text) {
  $("loading").classList.toggle("hidden", !on);
  if (text) $("loadingText").textContent = text;
}

function showView(name) {
  ["home", "new", "presets", "review", "audit"].forEach((v) => {
    const el = $(`view-${v}`);
    if (el) el.classList.toggle("hidden", v !== name);
  });
  document.querySelectorAll(".nav-item").forEach((a) => {
    a.classList.toggle(
      "active",
      a.dataset.view === name || (name === "review" && a.dataset.view === "home")
    );
  });
  // 审核页自动折叠侧栏，腾出图区
  if (name === "review") applySidebar(true);
  else if (localStorage.getItem(SIDEBAR_KEY) !== "1") applySidebar(false);
}

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (session.token) h["Authorization"] = `Bearer ${session.token}`;
  // Header 只能是 ISO-8859-1；中文显示名（如「魏炜」）会直接导致 fetch 抛错。
  // 已登录时身份以 Bearer token 为准，不必再塞 X-Actor。
  // 未登录兜底：URI 编码，后端 unquote。
  if (session.name && !session.token) {
    try {
      h["X-Actor"] = encodeURIComponent(session.name);
    } catch (_) {
      /* ignore */
    }
  }
  return h;
}

async function api(path, opts = {}) {
  const headers = { ...authHeaders(), ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  } else {
    delete headers["Content-Type"];
  }
  const r = await fetch(API + path, { ...opts, headers });
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const j = await r.json();
      detail = j.detail || JSON.stringify(j);
    } catch (_) {}
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) return r.json();
  return r;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderUser() {
  const logged = !!session.token && !!session.name;
  const role = session.role || "";
  $("userLabel").textContent = logged
    ? `● ${session.name}${role ? " · " + role : ""}`
    : "未登录";
  $("loginName").classList.toggle("hidden", logged);
  $("btnLogin").classList.toggle("hidden", logged);
  $("btnLogout").classList.toggle("hidden", !logged);
  if (!logged) $("loginName").value = session.name || "";
  // 权限显隐
  $("btnComplete")?.classList.toggle("hidden", !can("complete"));
  $("btnAiReview")?.classList.toggle("hidden", !can("ai_review"));
  $("btnBackup")?.classList.toggle("hidden", !can("backup"));
  $("btnArchiveFeishu")?.classList.toggle("hidden", !can("archive"));
  $("btnReportPdf")?.classList.toggle("hidden", !can("export"));
  $("btnDeleteTask")?.classList.toggle("hidden", !can("delete"));
  document.querySelectorAll("[data-need-create]").forEach((el) => {
    el.classList.toggle("is-disabled", !can("create"));
  });
  // 任务卡删除按钮随权限刷新
  document.querySelectorAll("[data-del]").forEach((el) => {
    el.classList.toggle("hidden", !can("delete"));
  });
}

async function doLogin() {
  const name = ($("loginName").value || "").trim() || "审核员";
  try {
    const s = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ display_name: name }),
    });
    session.token = s.token;
    session.name = s.display_name;
    session.role = s.role || "reviewer";
    session.perms = s.perms || [];
    localStorage.setItem(TOKEN_KEY, s.token);
    localStorage.setItem(NAME_KEY, s.display_name);
    localStorage.setItem("wb_role", session.role);
    renderUser();
    toast(`已进入：${s.display_name}（${session.role}）`);
  } catch (e) {
    toast(e.message);
  }
}

async function doLogout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (_) {}
  session = { token: "", name: "", role: "", perms: [] };
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(NAME_KEY);
  localStorage.removeItem("wb_role");
  renderUser();
  toast("已退出");
}

async function refreshMe() {
  if (!session.token) {
    renderUser();
    return;
  }
  try {
    const me = await api("/api/auth/me");
    if (me.logged_in) {
      session.name = me.display_name;
      session.role = me.role || "reviewer";
      session.perms = me.perms || [];
      localStorage.setItem(NAME_KEY, me.display_name);
      localStorage.setItem("wb_role", session.role);
    } else {
      session = { token: "", name: session.name || "", role: "", perms: [] };
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch (_) {}
  renderUser();
}

/* ========== Health ========== */
async function refreshHealth() {
  try {
    const h = await api("/api/health");
    const b = h.baidu || {};
    $("baiduStatus").textContent = b.ok
      ? `百度 OCR · ${b.api || "ok"}`
      : `百度未就绪 · ${b.error || "?"}`;
    const f = h.feishu || {};
    $("feishuStatus").textContent = f.enabled
      ? `飞书 · ${f.display_name || "个人"} · ${f.lark_cli ? "cli✓" : "cli✗"}`
      : "飞书未配置";
    const m = h.minimax || {};
    if (m.configured) {
      $("baiduStatus").title = `MiniMax ${m.model} 已配置 · 复核引擎 ${m.wired ? "已接" : "待接"}`;
    }
  } catch (e) {
    $("baiduStatus").textContent = "后端未连接";
  }
}

/* ========== Audit ========== */
async function loadAudit() {
  const list = await api("/api/audit?limit=100");
  const el = $("auditList");
  if (!list.length) {
    el.innerHTML = `<div class="empty-state"><h3>暂无审计记录</h3><p>登录、建任务、决策后会出现在这里</p></div>`;
    return;
  }
  el.innerHTML = list
    .map((a) => {
      const d = a.detail ? JSON.stringify(a.detail).slice(0, 280) : "";
      return `<div class="audit-row">
        <div class="a-head">
          <span class="a-action">${escapeHtml(a.action)}</span>
          <span class="a-meta">${escapeHtml(a.at || "")}</span>
        </div>
        <div class="a-meta">${escapeHtml(a.actor || "")}${a.task_id ? " · task " + escapeHtml(a.task_id) : ""}</div>
        ${d ? `<div class="a-detail">${escapeHtml(d)}</div>` : ""}
      </div>`;
    })
    .join("");
}

/* ========== Tasks ========== */
async function loadTasks() {
  const list = await api("/api/tasks");
  const el = $("taskList");
  if (!list.length) {
    el.innerHTML = `<div class="empty-state">
      <h3>还没有任务</h3>
      <p>请先登录显示名，再上传或从样本库创建</p>
      <button class="btn primary" data-view="new">新建任务</button>
    </div>`;
    el.querySelector("[data-view]").onclick = () => showView("new");
    return;
  }
  const canDel = can("delete");
  el.innerHTML = list
    .map((t) => {
      const s = t.summary || {};
      return `<div class="card">
        <div class="card-body">
          <h3>${escapeHtml(t.title)}</h3>
          <p>${escapeHtml(t.status)} · ${escapeHtml(t.type)} · ${escapeHtml(t.id)}</p>
          <div class="card-meta">
            ${s["一致"] != null ? `<span class="pill ok">一致 ${s["一致"]}</span>` : ""}
            ${s["疑点"] != null ? `<span class="pill warn">疑点 ${s["疑点"]}</span>` : ""}
            ${s["缺失"] != null ? `<span class="pill miss">缺失 ${s["缺失"]}</span>` : ""}
            ${t.owner ? `<span class="pill blue">归属 ${escapeHtml(t.owner)}</span>` : ""}
            ${t.completed_by ? `<span class="pill blue">终审 ${escapeHtml(t.completed_by)}</span>` : ""}
          </div>
        </div>
        <div class="card-actions">
          <button class="btn primary" data-open="${t.id}">打开审核</button>
          ${
            canDel
              ? `<button class="btn danger" data-del="${t.id}" data-title="${escapeHtml(t.title)}" title="删除任务及上传文件">删除</button>`
              : ""
          }
        </div>
      </div>`;
    })
    .join("");
  el.querySelectorAll("[data-open]").forEach((btn) => {
    btn.onclick = () => openTask(btn.dataset.open);
  });
  el.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteTask(btn.dataset.del, btn.dataset.title || "");
    };
  });
}

async function deleteTask(id, title) {
  if (!can("delete")) {
    toast("当前角色无删除权限（需审核员/管理员）");
    return;
  }
  if (!id) return;
  const label = (title || id).slice(0, 40);
  const ok = window.confirm(
    `确定删除任务？\n\n「${label}」\nID: ${id}\n\n将永久删除任务记录、OCR 页与源文件，不可恢复。`
  );
  if (!ok) return;
  loading(true, "删除任务…");
  try {
    await api(`/api/tasks/${id}`, {
      method: "DELETE",
      body: JSON.stringify({
        actor: session.name || "审核员",
        confirm_title: (title || "").slice(0, 12) || null,
      }),
    });
    toast("已删除：" + label);
    if (currentTask && currentTask.id === id) {
      currentTask = null;
      showView("home");
    }
    await loadTasks();
  } catch (e) {
    toast("删除失败：" + e.message);
  } finally {
    loading(false);
  }
}

/* ========== Presets ========== */
async function loadPresets() {
  const list = await api("/api/presets");
  $("presetList").innerHTML = list
    .map(
      (p) => `<div class="card">
        <div class="card-body">
          <h3>${escapeHtml(p.title)}</h3>
          <p>${escapeHtml(p.type)}</p>
          <div class="card-meta">
            <span class="pill blue">预置</span>
            ${p.note ? `<span class="pill warn">${escapeHtml(p.note.slice(0, 40))}</span>` : ""}
          </div>
        </div>
        <button class="btn primary" data-preset="${p.id}">创建并识别</button>
      </div>`
    )
    .join("");
  $("presetList").querySelectorAll("[data-preset]").forEach((btn) => {
    btn.onclick = () => createFromPreset(btn.dataset.preset);
  });
}

async function createFromPreset(presetId) {
  if (!session.name && !session.token) {
    toast("请先在左侧输入显示名并进入");
    return;
  }
  const max_pages = Number($("maxPages").value || 2);
  loading(true, "创建任务 · 百度 OCR + 飞书通知…");
  try {
    const task = await api("/api/tasks/from-preset", {
      method: "POST",
      body: JSON.stringify({
        preset_id: presetId,
        max_pages,
        actor: session.name || "审核员",
        notify: true,
      }),
    });
    toast("任务已创建" + (task.feishu_create?.ok ? " · 已推飞书" : ""));
    await openTask(task.id);
  } catch (e) {
    toast("失败：" + e.message);
  } finally {
    loading(false);
  }
}

/* ========== Upload wizard ========== */
function setWizStep(n) {
  wizStep = n;
  [1, 2, 3].forEach((i) => {
    $(`wiz-${i}`).classList.toggle("hidden", i !== n);
  });
  document.querySelectorAll(".wstep").forEach((el) => {
    el.classList.toggle("on", Number(el.dataset.s) === n);
  });
  if (n === 2) renderDropZones();
  if (n === 3) renderConfirm();
}

function fmtSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function clearWizFile(key) {
  wizFiles[key] = null;
  renderDropZones();
  toast("已移除文件");
}

function clearAllWizFiles() {
  wizFiles = { excel: null, pdf: null, pdf_a: null, pdf_b: null };
  renderDropZones();
  toast("已清空全部已选文件");
}

function assignWizFile(key, file) {
  if (!file) return;
  const maxBytes = MAX_UPLOAD_MB_UI * 1024 * 1024;
  if (file.size > maxBytes) {
    toast(
      `文件过大 ${fmtSize(file.size)}（上限 ${MAX_UPLOAD_MB_UI}MB）：${file.name}。请压缩转曲或换较小 PDF。`
    );
    return;
  }
  wizFiles[key] = file;
  // 文件名含膜袋时自动切到膜袋
  if (key === "pdf" && /膜袋|pouch/i.test(file.name || "")) {
    wizPackSurface = "pouch";
  }
  renderDropZones();
}

function renderDropZones() {
  const zones = $("dropZones");
  const packLabel = wizPackSurface === "pouch" ? "膜袋 PDF" : "花盒 PDF";
  const specs =
    wizType === "excel_pdf"
      ? [
          { key: "excel", label: "Excel 确认单", accept: ".xlsx,.xls", hint: "拖入 .xlsx · 可点 × 移除" },
          {
            key: "pdf",
            label: packLabel,
            accept: ".pdf",
            hint: `必填 · 单面识别 · 上限 ${MAX_UPLOAD_MB_UI}MB · 可点 × 移除`,
          },
        ]
      : wizType === "cross_spec"
        ? [
            {
              key: "pdf_a",
              label: "规格 A（如 30ml）",
              accept: ".pdf",
              hint: "拖入 A 稿 · 可点 × 移除",
            },
            {
              key: "pdf_b",
              label: "规格 B（如 95ml）",
              accept: ".pdf",
              hint: "拖入 B 稿 · 可点 × 移除",
            },
          ]
        : wizType === "report_summary"
          ? [{ key: "pdf", label: "检测报告 PDF", accept: ".pdf", hint: "有文字层 · 可点 × 移除" }]
          : wizType === "pdf_internal"
            ? [
                {
                  key: "pdf",
                  label: "双页 PDF（推荐）",
                  accept: ".pdf",
                  hint: "一个含两面的平面图 · 列名=文件名·面1/面2",
                },
                {
                  key: "pdf_a",
                  label: "或：面 A 单独 PDF",
                  accept: ".pdf",
                  hint: "两文件模式时填 · 列名=本文件名",
                },
                {
                  key: "pdf_b",
                  label: "或：面 B 单独 PDF",
                  accept: ".pdf",
                  hint: "与面 A 成对 · 列名=本文件名",
                },
              ]
            : [{ key: "pdf", label: "包装 PDF", accept: ".pdf", hint: "含双页平面图 · 可点 × 移除" }];

  const surfaceBar =
    wizType === "excel_pdf"
      ? `<div class="surface-pick" id="surfacePick">
          <span class="surface-pick-label">识别面（二选一）</span>
          <button type="button" class="chip surface-chip ${
            wizPackSurface === "carton" ? "on" : ""
          }" data-surface="carton">花盒</button>
          <button type="button" class="chip surface-chip ${
            wizPackSurface === "pouch" ? "on" : ""
          }" data-surface="pouch">膜袋</button>
          <span class="muted" style="font-size:12px;margin-left:8px">每次只识别一面，勿同时传花盒+膜袋</span>
        </div>`
      : "";

  const hasAny = Object.values(wizFiles).some(Boolean);
  zones.innerHTML =
    surfaceBar +
    specs
      .map((s) => {
        const f = wizFiles[s.key];
        return `<div class="drop-zone ${f ? "has-file" : ""}" data-key="${s.key}">
        <div class="drop-label">${s.label}</div>
        <div class="drop-hint">${s.hint}</div>
        <div class="drop-file">${
          f
            ? `${escapeHtml(f.name)} · ${fmtSize(f.size)}`
            : "未选择 · 点击或拖入"
        }</div>
        ${
          f
            ? `<button type="button" class="btn small danger drop-clear" data-clear="${s.key}" title="移除该文件">× 移除</button>`
            : ""
        }
        <input type="file" accept="${s.accept}" data-key="${s.key}" />
      </div>`;
      })
      .join("") +
    (hasAny
      ? `<div class="drop-actions"><button type="button" class="btn small" id="btnClearAllFiles">清空全部已选文件</button></div>`
      : "");

  $("surfacePick")
    ?.querySelectorAll("[data-surface]")
    .forEach((btn) => {
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        wizPackSurface = btn.dataset.surface || "carton";
        // 切换面时清空包装 PDF，避免花盒/膜袋搞混
        if (wizFiles.pdf) {
          wizFiles.pdf = null;
          toast("已切换识别面，请重新选择对应 PDF");
        }
        renderDropZones();
      };
    });

  $("btnClearAllFiles") && ($("btnClearAllFiles").onclick = () => clearAllWizFiles());

  zones.querySelectorAll(".drop-clear").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearWizFile(btn.dataset.clear);
    };
  });

  zones.querySelectorAll(".drop-zone").forEach((zone) => {
    const key = zone.dataset.key;
    const input = zone.querySelector("input");
    if (!input) return;
    input.onchange = () => {
      if (input.files?.[0]) assignWizFile(key, input.files[0]);
    };
    zone.ondragover = (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    };
    zone.ondragleave = () => zone.classList.remove("dragover");
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
      const f = e.dataTransfer?.files?.[0];
      if (f) assignWizFile(key, f);
    };
  });
}

function renderConfirm() {
  const typeLabel = {
    excel_pdf: "Excel ↔ 包装 PDF",
    cross_spec: "跨规格对齐",
    report_summary: "检测报告 → Word",
    pdf_internal: "双页文案对比",
  }[wizType];
  const surfaceLabel =
    wizType === "excel_pdf"
      ? wizPackSurface === "pouch"
        ? "膜袋"
        : "花盒"
      : wizType === "pdf_internal"
        ? wizFiles.pdf_a && wizFiles.pdf_b
          ? "两文件 · 各取文件名"
          : "单双页 PDF · 文件名·面1/面2"
        : "—";
  const files = Object.entries(wizFiles)
    .filter(([, f]) => f)
    .map(
      ([k, f]) =>
        `<dt>${k}</dt><dd>${escapeHtml(f.name)} · ${fmtSize(f.size)}
         <button type="button" class="btn small danger" data-confirm-clear="${k}">移除</button></dd>`
    )
    .join("");
  $("confirmBox").innerHTML = `
    <dl>
      <dt>类型</dt><dd>${typeLabel}</dd>
      <dt>${wizType === "pdf_internal" ? "对照列名" : "识别面"}</dt><dd>${surfaceLabel}${
        wizType === "excel_pdf" ? "（单面）" : ""
      }</dd>
      <dt>名称</dt><dd>${escapeHtml($("uploadTitle").value || "（默认）")}</dd>
      <dt>页数</dt><dd>${$("uploadMaxPages").value}</dd>
      <dt>操作人</dt><dd>${escapeHtml(session.name || "匿名")}</dd>
      <dt>文件</dt>
      ${files || "<dd>未选文件</dd>"}
    </dl>
    <p class="muted" style="font-size:12px;margin-top:10px">${
      wizType === "pdf_internal"
        ? "双页文案对比可单独验收，不依赖 Excel。单双页 PDF 或两文件二选一。"
        : "传错可点「移除」或返回上一步重选。"
    } 单文件上限 ${MAX_UPLOAD_MB_UI}MB。</p>`;
  $("confirmBox").querySelectorAll("[data-confirm-clear]").forEach((btn) => {
    btn.onclick = () => {
      clearWizFile(btn.dataset.confirmClear);
      renderConfirm();
    };
  });
}

function validateFiles() {
  if (wizType === "excel_pdf") return !!(wizFiles.excel && wizFiles.pdf);
  if (wizType === "cross_spec") return !!(wizFiles.pdf_a && wizFiles.pdf_b);
  if (wizType === "pdf_internal") {
    // 单双页 PDF，或两文件各一面
    if (wizFiles.pdf) return true;
    return !!(wizFiles.pdf_a && wizFiles.pdf_b);
  }
  if (wizType === "report_summary") return !!wizFiles.pdf;
  return false;
}

async function submitUpload() {
  if (!session.name && !session.token) {
    toast("请先在左侧输入显示名并进入");
    return;
  }
  if (!validateFiles()) {
    toast(
      wizType === "pdf_internal"
        ? "请上传一个双页 PDF，或同时上传面 A + 面 B 两个 PDF"
        : "请补全所需文件（Excel + 花盒或膜袋 PDF 二选一）"
    );
    return;
  }
  // 再拦一次超大文件
  for (const f of Object.values(wizFiles)) {
    if (f && f.size > MAX_UPLOAD_MB_UI * 1024 * 1024) {
      toast(`存在超过 ${MAX_UPLOAD_MB_UI}MB 的文件：${f.name}`);
      return;
    }
  }
  const fd = new FormData();
  fd.append("task_type", wizType);
  fd.append("title", $("uploadTitle").value || "上传任务");
  fd.append("max_pages", $("uploadMaxPages").value || "2");
  fd.append("actor", session.name || "审核员");
  fd.append("notify", "true");
  if (wizType === "excel_pdf") {
    fd.append("excel", wizFiles.excel);
    fd.append("pdf", wizFiles.pdf);
    fd.append("pack_surface", wizPackSurface === "pouch" ? "pouch" : "carton");
  } else if (wizType === "cross_spec") {
    fd.append("pdf_a", wizFiles.pdf_a);
    fd.append("pdf_b", wizFiles.pdf_b);
  } else if (wizType === "pdf_internal") {
    if (wizFiles.pdf_a && wizFiles.pdf_b) {
      fd.append("pdf_a", wizFiles.pdf_a);
      fd.append("pdf_b", wizFiles.pdf_b);
    } else {
      fd.append("pdf", wizFiles.pdf);
    }
  } else {
    fd.append("pdf", wizFiles.pdf);
  }
  loading(
    true,
    wizType === "report_summary"
      ? "抽取结论页并生成 Word… MiniMax 摘抄中"
      : wizType === "pdf_internal"
        ? "双页文案对比中… OCR 主识别 + 交叉校验（约 1–3 分钟）"
        : `上传识别中（${wizPackSurface === "pouch" ? "膜袋" : "花盒"}单面）…`
  );
  try {
    const task = await api("/api/tasks/upload", { method: "POST", body: fd });
    toast(
      "任务已创建 · " +
        (task.pack_surface || task.label_a || "") +
        (task.feishu_create?.ok ? " · 已推飞书" : "")
    );
    wizFiles = { excel: null, pdf: null, pdf_a: null, pdf_b: null };
    wizPackSurface = "carton";
    setWizStep(1);
    await openTask(task.id);
  } catch (e) {
    toast("失败：" + e.message);
  } finally {
    loading(false);
  }
}

/* ========== Review + bbox ========== */
function normalizePages(pages) {
  if (!pages || !pages.length) return [];
  return pages.map((p, i) => {
    if (typeof p === "string") {
      return { url: p, page: i + 1, width: 0, height: 0 };
    }
    return {
      url: p.url || p,
      page: p.page || i + 1,
      width: p.width || 0,
      height: p.height || 0,
      name: p.name,
    };
  });
}

async function openTask(id) {
  loading(true, "加载任务…");
  try {
    currentTask = await api(`/api/tasks/${id}`);
    pageIdx = 0;
    filter = "todo";
    selectedHitId = null;
    sideAB = "a";
    if (window.ViewerOSD) ViewerOSD.destroyAll();
    openMeta = { a: null, b: null, s: null };
    // 双 PDF 任务默认双图；Excel 单面=确认单面板；Excel 双面(花盒+膜袋)=双图+确认单
    // PDF 文字对比：无图工作台
    const hasB = (currentTask.pages_b || []).length > 0;
    const excelMode = currentTask.type === "excel_pdf";
    const multiSurf = excelMode && !!currentTask.multi_surface;
    const textCmp = isPdfTextCompareTask(currentTask);
    viewMode = textCmp
      ? "text"
      : hasB && (!excelMode || multiSurf)
        ? "compare"
        : "single";
    const todo = (currentTask.hits || []).filter(
      (h) => ["疑点", "缺失"].includes(h.status) && h.decision === "pending"
    );
    // 文字对比：默认全部·按 PDF 阅读序，方便顺着改
    if (textCmp) {
      filter = "all";
      window.__tcFilter = "all";
    } else if (hasB && todo.length && (!excelMode || multiSurf)) {
      viewMode = "compare";
    }
    renderReview();
    showView("review");
    // Excel：优先跳到第一条待处理，展开确认单原文
    const first =
      (todo[0] && todo[0].id) ||
      (excelMode && currentTask.hits?.[0]?.id) ||
      null;
    if (first && !textCmp) {
      setTimeout(() => selectHit(first), excelMode ? 500 : 400);
    } else if (excelMode) {
      setTimeout(() => renderExcelFieldPanel(null), 200);
    } else if (textCmp && todo[0]) {
      setTimeout(() => selectHit(todo[0].id), 200);
    }
  } catch (e) {
    toast(e.message);
  } finally {
    loading(false);
  }
}

function hasDualPages(t) {
  return (t?.pages_b || []).length > 0;
}

/** PDF 双页/双稿：纯文字对比工作台（无图） */
function isPdfTextCompareTask(t = currentTask) {
  if (!t) return false;
  if (t.ui_mode === "text_compare") return true;
  return ["pdf_internal", "cross_spec", "pdf_pdf"].includes(t.type);
}

function statusClass(st) {
  if (st === "缺失") return "miss";
  if (st === "一致") return "ok";
  return "warn";
}

async function openOsdForCurrentPages() {
  if (!window.OpenSeadragon) {
    toast("OpenSeadragon 未加载，请检查 /static/osd/openseadragon.min.js");
    return;
  }
  if (!window.ViewerOSD || !currentTask) return;
  const t = currentTask;
  const pagesA = normalizePages(t.pages);
  const pagesB = normalizePages(t.pages_b || []);
  const pageA = pagesA[pageIdx] || pagesA[0];
  const pageB = pagesB[pageIdx] || pagesB[0];
  const dual = hasDualPages(t) && viewMode === "compare";

  // 邻页预加载，翻页更顺
  const preloadUrls = [];
  for (const arr of [pagesA, pagesB]) {
    if (!arr.length) continue;
    const i = pageIdx;
    if (arr[i - 1]) preloadUrls.push(arr[i - 1].url);
    if (arr[i + 1]) preloadUrls.push(arr[i + 1].url);
  }
  ViewerOSD.preload?.(preloadUrls);

  // 等布局显示后再初始化（否则容器高度 0 → 黑屏）
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    if (dual && pageA && pageB) {
      openMeta.a = pageA;
      openMeta.b = pageB;
      await ViewerOSD.openCompare(
        pageA.url,
        pageB.url,
        { w: pageA.width || 1, h: pageA.height || 1 },
        { w: pageB.width || 1, h: pageB.height || 1 }
      );
    } else {
      const page = sideAB === "b" && pageB ? pageB : pageA || pageB;
      if (!page) return;
      openMeta.s = page;
      openMeta.a = pageA;
      openMeta.b = pageB;
      await ViewerOSD.openSingle(page.url, page.width || 1, page.height || 1);
    }
    // 再 resize 一次，避免首次全屏/侧栏折叠后尺寸不对
    setTimeout(() => {
      ViewerOSD.resize();
      drawHighlights();
    }, 80);
    drawHighlights();
  } catch (e) {
    console.error(e);
    toast("图片打开失败：" + (e.message || e));
  }
}

function isExcelPdfTask(t) {
  return (t || currentTask)?.type === "excel_pdf";
}

function isExcelMultiSurface(t) {
  const task = t || currentTask;
  return !!(task && task.type === "excel_pdf" && task.multi_surface && (task.pages_b || []).length);
}

/** 确认单面板挂载点：单面=侧栏；双面三栏=中间 */
function excelPanelHost() {
  if (isExcelMultiSurface() && viewMode === "compare") {
    return $("excelDetailHostMid") || $("excelDetailHost");
  }
  return $("excelDetailHost");
}

/** Excel↔PDF：确认单原文 + 包装命中区（人审主路径，不是 A/B） */
async function renderExcelFieldPanel(hit) {
  const host = excelPanelHost();
  const hostSide = $("excelDetailHost");
  const hostMid = $("excelDetailHostMid");
  if (!host) return;
  if (!isExcelPdfTask()) {
    hostSide?.classList.add("hidden");
    hostMid?.classList.add("hidden");
    $("singleWithDetail")?.classList.remove("is-excel-pdf");
    $("viewerCompare")?.classList.remove("is-excel-triple");
    return;
  }

  const triple = isExcelMultiSurface() && viewMode === "compare";
  if (triple) {
    hostSide?.classList.add("hidden");
    $("singleWithDetail")?.classList.remove("is-excel-pdf");
    $("viewerCompare")?.classList.add("is-excel-triple");
    hostMid?.classList.remove("hidden");
  } else {
    hostMid?.classList.add("hidden");
    $("viewerCompare")?.classList.remove("is-excel-triple");
    $("singleWithDetail")?.classList.add("is-excel-pdf");
    hostSide?.classList.remove("hidden");
  }

  if (!hit) {
    const triple = isExcelMultiSurface() && viewMode === "compare";
    host.innerHTML = `<div class="excel-empty">
      <h4>Excel ↔ 包装定位</h4>
      ${
        triple
          ? `<p><b>三栏</b>：左 ${escapeHtml(currentTask.label_a || "花盒")} · 中确认单 · 右 ${escapeHtml(
              currentTask.label_b || "膜袋"
            )}</p>`
          : `<p>本任务不是 A/B 双稿对比。</p>`
      }
      <p>从右侧点选一条确认单字段：</p>
      <ol>
        <li>${triple ? "中间" : "侧栏"}显示 <b>Excel 应印原文</b></li>
        <li>${triple ? "对应面" : "左侧"}包装图放大到 <b>命中位置</b></li>
        <li>下方裁剪核对定位</li>
      </ol>
      <p class="muted" style="margin-top:12px">装型画像会忽略非本装条码；双面字段带花盒/膜袋标签。</p>
    </div>`;
    return;
  }

  const st = hit.status || "—";
  const stClass =
    st === "缺失" ? "miss" : st === "疑点" ? "warn" : st === "一致" ? "ok" : "";
  const cov = hit.coverage;
  const boxes = hit.bboxes || [];
  const long = !!(hit.long_field || (hit.excel_value || "").length > 120);
  const seq = hit.sequence_diff;
  const missFromCov = cov?.miss || [];
  const missFromSeq = seq?.only_in_excel || [];
  const missAll = [...new Set([...missFromCov, ...missFromSeq])].slice(0, 10);
  // C 端：仅 coverage.miss；忽略装条码 / sequence 碎片不进「建议核对」
  const ignoredCodes = new Set(
    (hit.barcode_card?.codes || [])
      .filter((c) => c.required === false || c.status === "忽略")
      .map((c) => c.code)
  );
  const missPrimary = (missFromCov.length ? missFromCov : [])
    .filter((m) => !ignoredCodes.has(String(m).replace(/\D/g, "") || m))
    .filter((m) => !ignoredCodes.has(m))
    .slice(0, 8);
  const needHuman =
    hit.status === "疑点" ||
    hit.status === "缺失" ||
    (hit.field_group === "二维码" && hit.decision === "pending");
  const missTitle =
    hit.field_group === "文案"
      ? "漏印原文（确认单有 · 包装未见/OCR未识）"
      : hit.field_group === "成分表"
        ? "成分未见项（请在本步骤整段：主体+其他微量 内查找）"
        : "建议在图上核对（待处理）";
  const missHtml =
    missPrimary.length && needHuman
      ? `<div class="excel-sec miss-detail"><p class="excel-sec-label">${missTitle}</p>
         <p class="muted" style="font-size:11px;margin:0 0 6px">下面就是<strong>具体漏了什么</strong>（逐条对照包装）：</p>
         <ol class="excel-miss-list miss-ol">${missPrimary
           .map(
             (m, i) =>
               `<li><span class="miss-idx">漏${i + 1}.</span> <code class="miss-text">${escapeHtml(
                 m
               )}</code></li>`
           )
           .join("")}</ol>
         ${
           hit.doubt_bucket === "typo"
             ? `<p class="muted" style="font-size:11px;margin-top:8px">分桶「真漏字」= 疑似单字/短词错印；请对照上表原文。</p>`
             : hit.doubt_bucket === "coverage" || hit.field_group === "文案"
               ? `<p class="muted" style="font-size:11px;margin-top:8px">分桶「条款/覆盖」= 整句脚注/条款可能未印或字太小 OCR 未识，不是卖点标题漏字。</p>`
               : ""
         }</div>`
      : hit.status === "疑点" && hit.field_group === "二维码"
        ? `<div class="excel-sec"><p class="excel-sec-label">待人工扫码</p>
           <p class="muted" style="font-size:12px">请用手机扫描图上二维码，确认是否跳转译龄公众号/正确落地页。</p></div>`
        : hit.status === "疑点"
          ? `<div class="excel-sec"><p class="excel-sec-label">疑点说明</p>
           <p class="muted" style="font-size:12px">请结合高亮与备注判断是否需改稿。</p></div>`
          : "";
  const packExtras = (seq?.only_in_pack || []).filter(
    (m) => !/使用方法|其他微量|成分：/.test(String(m))
  );
  const extraHtml =
    packExtras.length || (hit.reverse_extras || []).length
      ? `<div class="excel-sec"><p class="excel-sec-label">包装多出（已滤跨列粘连）</p>
         <ul class="excel-miss-list extra">${packExtras
           .slice(0, 6)
           .map((m) => `<li>${escapeHtml(m)}</li>`)
           .join("")}${(hit.reverse_extras || [])
           .slice(0, 6)
           .map((e) => `<li>${escapeHtml(e.text || e)}</li>`)
           .join("")}</ul></div>`
      : "";
  const bc = hit.barcode_card;
  const barcodeHtml = bc?.codes?.length
    ? `<div class="excel-sec"><p class="excel-sec-label">条码核对卡 · ${escapeHtml(
        bc.summary || ""
      )}</p>
      <div class="barcode-card">${bc.codes
        .map(
          (c) =>
            `<div class="barcode-row ${c.found ? "ok" : "miss"}"><code>${escapeHtml(
              c.code
            )}</code><span>${c.found ? "✓ 包装上找到" : "✗ 未找到"}</span></div>`
        )
        .join("")}</div></div>`
    : "";

  const blockMode =
    hit.bbox_mode === "block" ||
    hit.bbox_mode === "dual_track" ||
    hit.long_field;
  const blockSize = hit.block_size
    ? ` · 框 ${hit.block_size.width}×${hit.block_size.height}px`
    : "";
  const nHit = (boxes || []).filter((b) => !b.role || b.role === "hit").length;
  const nCheck = (boxes || []).filter(
    (b) => b.role === "check" || b.role === "miss_anchor"
  ).length;
  const legendHtml =
    boxes.length > 0
      ? `<div class="bbox-legend">
          ${nHit ? `<span class="lg-hit">蓝框 已命中字 ×${nHit}</span>` : ""}
          ${nCheck ? `<span class="lg-check">黄框 疑点核对 ×${nCheck}</span>` : ""}
          <span class="muted" style="font-size:11px">词级定位 · 漏印落期望区</span>
        </div>`
      : "";
  let cropHtml = `<div class="excel-sec"><p class="excel-sec-label">包装命中区</p>
    <div class="muted" style="font-size:12px;padding:8px 0">无坐标 · 请对照左侧全图 / 文字证据</div></div>`;
  if (boxes.length && window.ViewerOSD) {
    try {
      // 整段字段：多留边距；双面时从对应面 viewer 裁剪
      let cropSide = "s";
      if (isExcelMultiSurface() && viewMode === "compare" && hit.surface) {
        cropSide =
          hit.surface === (currentTask.label_b || "") || hit.surface === "膜袋"
            ? "b"
            : "a";
      }
      const dataUrl = ViewerOSD.cropFromSide
        ? await ViewerOSD.cropFromSide(cropSide, boxes, blockMode ? 80 : 56)
        : await ViewerOSD.cropFromSingle(boxes, blockMode ? 80 : 56);
      if (dataUrl) {
        cropHtml = `<div class="excel-sec"><p class="excel-sec-label">包装定位 · ${
          hit.bbox_mode === "dual_track"
            ? "双轨（命中+疑点）"
            : blockMode
              ? "整段"
              : "点定位"
        } · 页 ${hit.page || boxes[0].page || "?"} · ${boxes.length} 区${blockSize}</p>
          ${legendHtml}
          <div class="excel-crop-wrap"><img src="${dataUrl}" alt="命中区域" class="detail-crop-img" /></div>
          <div class="muted" style="font-size:11px;margin-top:6px">${
            nCheck
              ? "请先看黄框（疑点/漏印期望区），蓝框为已找到的字"
              : blockMode
                ? "蓝框为词级/整段命中；最终以左侧全图高亮为准"
                : "裁剪仅供核对；最终以左侧全图高亮为准"
          }</div>
        </div>`;
      }
    } catch (_) {}
  }

  const canDecide = typeof can === "function" ? can("decide") : true;
  const todoN = pendingTodoHits().length;
  const nextBtn =
    todoN > 0
      ? `<button class="btn primary" data-next-todo type="button" title="跳到下一条待处理">下一个待处理${
          todoN > 1 ? ` (${todoN})` : ""
        }</button>`
      : `<span class="muted" style="font-size:12px;align-self:center">无更多待处理</span>`;
  const actions =
    hit.decision === "pending" && canDecide
      ? `<button class="btn ok" data-d="confirm" data-id="${hit.id}">确认一致</button>
         <button class="btn miss" data-d="issue" data-id="${hit.id}">标为问题</button>
         <button class="btn" data-d="ignore" data-id="${hit.id}">忽略</button>
         ${nextBtn}`
      : hit.decision !== "pending" && canDecide
        ? `<button class="btn" data-d="pending" data-id="${hit.id}">改判</button>
           ${nextBtn}
           <span class="muted" style="font-size:12px;align-self:center">已 ${escapeHtml(
             hit.decision
           )}${hit.decided_by ? " · " + escapeHtml(hit.decided_by) : ""}</span>`
        : `${nextBtn}<span class="muted" style="font-size:12px">只读</span>`;

  host.innerHTML = `
    <div class="excel-panel">
      <div class="excel-panel-head">
        <p class="excel-panel-kicker">确认单字段 · Excel → 包装</p>
        <h3 class="excel-panel-title">
          <span>${escapeHtml(hit.field || "")}</span>
          <span class="tag ${stClass}">${escapeHtml(st)}</span>
        </h3>
        <div class="excel-panel-meta">
          ${
            cov?.total
              ? `覆盖 <b>${cov.matched}/${cov.total}</b>`
              : hit.field_group
                ? escapeHtml(hit.field_group)
                : ""
          }
          ${hit.surface ? ` · ${escapeHtml(hit.surface)}` : ""}
        </div>
      </div>
      <div class="excel-panel-body">
        <div class="excel-sec">
          <p class="excel-sec-label">Excel 应印内容</p>
          <pre class="excel-sec-body ${long ? "is-long" : ""}">${escapeHtml(
            hit.excel_value || "（空）"
          )}</pre>
        </div>
        ${
          hit.remark
            ? `<div class="excel-sec"><p class="excel-sec-label">Excel 备注 / 设计要求</p>
               <pre class="excel-sec-body remark">${escapeHtml(hit.remark)}</pre></div>`
            : ""
        }
        ${barcodeHtml}
        ${missHtml}
        ${extraHtml}
        ${cropHtml}
        <div class="excel-sec">
          <p class="excel-sec-label">机审证据${
            seq?.ratio != null ? ` · diff ${Number(seq.ratio).toFixed(2)}` : ""
          }</p>
          <pre class="excel-sec-body evidence">${escapeHtml(hit.evidence || "—")}</pre>
        </div>
      </div>
      <div class="excel-panel-foot">${actions}</div>
    </div>`;

  host.querySelectorAll("[data-d]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      decide(btn.dataset.id, btn.dataset.d);
    };
  });
  host.querySelectorAll("[data-next-todo]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      goNextTodo(hit.id);
    };
  });
}

/** 待处理（疑点/缺失且未决） */
function pendingTodoHits(hits) {
  const list = hits || currentTask?.hits || [];
  return list.filter(
    (h) =>
      ["疑点", "缺失"].includes(h.status) &&
      (h.decision === "pending" || !h.decision)
  );
}

/** 下一条待处理 id（从 afterId 之后环形查找） */
function nextPendingHitId(afterId, hits) {
  const all = hits || currentTask?.hits || [];
  const pending = pendingTodoHits(all);
  if (!pending.length) return null;
  if (!afterId) return pending[0].id;
  const start = all.findIndex((h) => h.id === afterId);
  if (start < 0) return pending[0].id;
  for (let i = 1; i <= all.length; i++) {
    const h = all[(start + i) % all.length];
    if (
      h &&
      ["疑点", "缺失"].includes(h.status) &&
      (h.decision === "pending" || !h.decision)
    ) {
      return h.id;
    }
  }
  return null;
}

function goNextTodo(afterId) {
  const nid = nextPendingHitId(afterId);
  if (!nid) {
    toast("没有更多待处理");
    return;
  }
  if (nid === afterId && pendingTodoHits().length <= 1) {
    toast("仅剩当前这一条待处理");
    selectHit(nid);
    return;
  }
  selectHit(nid);
}

function isCharDiffHit(h) {
  if (!h) return false;
  if (String(h.id || "").startsWith("lcs_")) return true;
  return (
    h.category === "issue" &&
    /字符差异|差在这些字|未完全对上/.test(`${h.field || ""}${h.evidence || ""}`)
  );
}

function isUnmatchedHit(h) {
  if (!h) return false;
  if (h.category === "unmatched") return true;
  return /未对上/.test(h.field || "");
}

/** 从 hit 拆出 A/B 一一对应文本 */
function splitPairTexts(h) {
  const raw = h.excel_value || "";
  let a = "";
  let b = (h.text_b || "").trim();
  if (raw.includes("\nB:") || /^A:\s*/m.test(raw)) {
    const parts = raw.split(/\nB:\s*/);
    a = (parts[0] || "").replace(/^A:\s*/i, "").trim();
    if (!b && parts[1]) b = parts[1].trim();
  } else if (h.category === "face_split") {
    if (h.side === "b") {
      a = "";
      b = raw.trim();
    } else {
      a = raw.trim();
      b = "";
    }
  } else {
    a = raw.trim();
  }
  return { a, b };
}

function pairReadKey(h) {
  const ro = h?.read_order || {};
  // 栏左→右，栏内上→下（与后端 read_order_key 一致）
  if (h?.read_order_key && Array.isArray(h.read_order_key)) {
    return h.read_order_key.map((x) => Number(x) || 0);
  }
  if (h?.seq != null && !ro.column && ro.column !== 0) {
    return [0, Number(h.seq) || 0, 0, 0];
  }
  return [
    Number(ro.column) || 0,
    Number(ro.top) || 0,
    Number(ro.left) || 0,
    ro.side === "b" ? 1 : 0,
  ];
}

function buildTextComparePairs(t) {
  const hits = t.hits || [];
  const pairs = [];
  const pushFrom = (h, kind, note) => {
    const { a, b } = splitPairTexts(h);
    const side = h.side || "";
    pairs.push({
      id: h.id,
      kind,
      status: kind === "ok" ? "一致" : h.status || "疑点",
      decision: h.decision,
      a: kind === "miss" && side === "b" ? "" : a || (kind === "miss" ? h.excel_value || "" : a),
      b:
        kind === "miss" && side === "a"
          ? ""
          : b || (kind === "miss" && side === "b" ? h.excel_value || "" : b),
      note,
      hit: h,
      seq: h.seq,
      zone: h.zone || "",
      zone_label: h.zone_label || "",
      read_order: h.read_order,
      read_order_key: h.read_order_key,
    });
  };

  hits.filter(isCharDiffHit).forEach((h) => {
    const da = ((h.sequence_diff || {}).only_in_excel || []).slice(0, 5).join("、");
    const db = ((h.sequence_diff || {}).only_in_pack || []).slice(0, 5).join("、");
    pushFrom(
      h,
      "diff",
      da || db
        ? `【需审核】差：页1「${da || "—"}」· 页2「${db || "—"}」`
        : h.evidence || "【需审核】两边配对但文字不完全一致"
    );
  });
  hits.filter(isUnmatchedHit).forEach((h) => {
    pushFrom(h, "miss", h.evidence || "【需审核】对侧找不到可靠对应");
  });
  hits
    .filter((h) => h.category === "aligned")
    .forEach((h) => pushFrom(h, "ok", h.evidence || ""));
  hits
    .filter((h) => h.category === "face_split")
    .forEach((h) => pushFrom(h, "miss", h.evidence || "【需审核】仅单侧"));

  // 默认按 PDF 阅读序（上→下、左→右）
  pairs.sort((p, q) => {
    const ka = pairReadKey(p.hit || p);
    const kb = pairReadKey(q.hit || q);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (ka[i] || 0) - (kb[i] || 0);
      if (d) return d;
    }
    return String(p.id || "").localeCompare(String(q.id || ""));
  });
  return pairs;
}

function pageUrlOf(t, side) {
  const pages = side === "b" ? t.pages_b || [] : t.pages || [];
  if (!Array.isArray(pages) || !pages.length) return "";
  const p = pages[0] || {};
  return p.url || p.path || "";
}

function renderRedBoxStrip(t, labelA, labelB) {
  const boxesA = t.red_boxes_a || (t.zone_pipeline && t.zone_pipeline.red_boxes_a) || [];
  const boxesB = t.red_boxes_b || (t.zone_pipeline && t.zone_pipeline.red_boxes_b) || [];
  const urlA = pageUrlOf(t, "a");
  const urlB = pageUrlOf(t, "b");
  if (!urlA && !urlB) return "";
  if (!boxesA.length && !boxesB.length) return "";

  const active = window.__tcZone || "all";
  const paint = (boxes, side) =>
    (boxes || [])
      .map((b) => {
        const on = active === "all" || active === b.zone;
        const col = b.color || "#ef4444";
        return `<div class="roi-box ${on ? "on" : "dim"}" data-roi-zone="${escapeHtml(
          b.zone || ""
        )}" data-side="${side}" style="left:${(b.nx || 0) * 100}%;top:${
          (b.ny || 0) * 100
        }%;width:${(b.nw || 0) * 100}%;height:${(b.nh || 0) * 100}%;border-color:${col};" title="${escapeHtml(
          b.label || b.zone || ""
        )}"><span class="roi-lab" style="background:${col}">${escapeHtml(
          b.label || b.zone || ""
        )}</span></div>`;
      })
      .join("");

  return `<div class="roi-strip">
    <div class="roi-pane">
      <div class="roi-title">${escapeHtml(labelA)}</div>
      <div class="roi-stage">
        ${urlA ? `<img src="${escapeHtml(urlA)}" alt="A" draggable="false"/>` : ""}
        <div class="roi-layer">${paint(boxesA, "a")}</div>
      </div>
    </div>
    <div class="roi-pane">
      <div class="roi-title">${escapeHtml(labelB)}</div>
      <div class="roi-stage">
        ${urlB ? `<img src="${escapeHtml(urlB)}" alt="B" draggable="false"/>` : ""}
        <div class="roi-layer">${paint(boxesB, "b")}</div>
      </div>
    </div>
  </div>
  <p class="roi-hint">红框 = 两面同一套格子。点红框或下方芯片，只看该框内字差/未对上。</p>`;
}

function renderTextComparePane(t) {
  const host = $("textComparePane");
  if (!host) return;
  const brief = t.text_compare_brief || {};
  const labelA = brief.label_a || t.label_a || "页1";
  const labelB = brief.label_b || t.label_b || "页2";
  const verdict =
    brief.verdict || (pendingTodoHits(t.hits || []).length ? "需人审" : "通过");
  const vOk = verdict === "通过";
  const src =
    brief.source === "ai"
      ? "AI 归纳"
      : brief.source === "rule_fallback"
        ? "规则摘要（AI 不可用）"
        : "规则摘要";

  // 顶栏筛选；默认「全部」；可按红框 zone 滤
  if (!window.__tcFilter) window.__tcFilter = "all";
  if (!window.__tcZone) window.__tcZone = "all";
  const tcFilter = window.__tcFilter;
  const tcZone = window.__tcZone;
  let pairs = buildTextComparePairs(t);
  if (tcZone && tcZone !== "all") {
    pairs = pairs.filter((p) => (p.zone || "") === tcZone);
  }
  const counts = {
    all: pairs.length,
    need: pairs.filter((p) => p.kind === "diff" || p.kind === "miss").length,
    diff: pairs.filter((p) => p.kind === "diff").length,
    miss: pairs.filter((p) => p.kind === "miss").length,
    ok: pairs.filter((p) => p.kind === "ok").length,
  };
  if (tcFilter === "need")
    pairs = pairs.filter((p) => p.kind === "diff" || p.kind === "miss");
  if (tcFilter === "diff") pairs = pairs.filter((p) => p.kind === "diff");
  if (tcFilter === "miss") pairs = pairs.filter((p) => p.kind === "miss");
  if (tcFilter === "ok") pairs = pairs.filter((p) => p.kind === "ok");

  const bullets = (brief.bullets || []).length
    ? `<ul class="tc-bullets">${brief.bullets
        .map((b) => `<li>${escapeHtml(b)}</li>`)
        .join("")}</ul>`
    : "";

  const rows =
    pairs
      .map((p) => {
        const pill =
          p.kind === "diff"
            ? `<span class="pill-mini diff">字差</span>`
            : p.kind === "miss"
              ? `<span class="pill-mini miss">未对上</span>`
              : `<span class="pill-mini ok">一致</span>`;
        const rowCls =
          p.kind === "diff" ? "is-diff" : p.kind === "miss" ? "is-miss" : "";
        const aHtml = p.a
          ? escapeHtml(p.a.slice(0, 500))
          : `<span class="empty">（${escapeHtml(labelA)}无对应）</span>`;
        const bHtml = p.b
          ? escapeHtml(p.b.slice(0, 500))
          : `<span class="empty">（${escapeHtml(labelB)}无对应）</span>`;
        const needReview = p.kind === "diff" || p.kind === "miss";
        const actions =
          needReview && p.decision === "pending" && can("decide") && p.hit
            ? `<div class="tc-pair-actions">
                <button class="btn ok" data-d="confirm" data-id="${p.id}">确认一致</button>
                <button class="btn miss" data-d="issue" data-id="${p.id}">标为问题</button>
                <button class="btn" data-d="ignore" data-id="${p.id}">忽略</button>
              </div>`
            : needReview && p.decision && p.decision !== "pending"
              ? `<div class="tc-pair-actions"><span class="muted" style="font-size:12px">已判：${escapeHtml(
                  p.decision
                )}</span>
                ${
                  can("decide")
                    ? `<button class="btn" data-d="pending" data-id="${p.id}">改判</button>`
                    : ""
                }</div>`
              : "";
        const ocrConf = (p.hit && p.hit.ocr_confidence) || "";
        const confTip =
          ocrConf === "low"
            ? `<span class="pill-mini" style="background:#fef3c7;color:#92400e">OCR低置信</span>`
            : p.hit && p.hit.ocr_false_miss
              ? `<span class="pill-mini ok">OCR交叉回收</span>`
              : "";
        const note =
          needReview && p.note
            ? `<div class="tc-cell" style="grid-column:2/-1;border-top:1px dashed var(--border);padding-top:6px;font-size:11px;color:${
                p.kind === "miss" ? "#b91c1c" : "#b45309"
              }">${escapeHtml(p.note.slice(0, 220))}${
                ocrConf === "low" ? " · 建议优先核识字误差" : ""
              }</div>`
            : "";
        const seqLab =
          p.seq != null
            ? `#${p.seq}`
            : p.kind === "diff"
              ? "!"
              : p.kind === "miss"
                ? "?"
                : "✓";
        return `<div class="tc-pair ${rowCls}" data-tc-hit="${p.id}" id="tc-row-${escapeHtml(
          String(p.id)
        )}">
          <div class="tc-st">${pill}${confTip}<span style="font-size:10px;color:#94a3b8" title="改稿对照序号">${seqLab}</span></div>
          <div class="tc-cell ${p.a ? "" : "empty"}">${aHtml}</div>
          <div class="tc-cell ${p.b ? "" : "empty"}">${bHtml}</div>
          ${note}
          ${actions}
        </div>`;
      })
      .join("") ||
    `<div class="tc-empty"><strong>${
      tcFilter === "need" || tcFilter === "diff" || tcFilter === "miss"
        ? "当前无待审项"
        : "暂无对照行"
    }</strong>${
      tcFilter === "need"
        ? "可切换「全部」按版面顺序查看"
        : "换筛选或重新跑任务"
    }</div>`;

  const productLab = t.product_label || "双页文案对比";
  const zp = t.zone_pipeline || {};
  const zStats = zp.zone_stats || [];
  const hasRoi =
    (t.red_boxes_a || []).length > 0 ||
    (zp.red_boxes_a || []).length > 0 ||
    zp.ok;
  const zoneBar =
    zStats.length > 0
      ? `<div class="tc-zone-bar">
        <span class="chip ${tcZone === "all" ? "on" : ""}" data-tc-zone="all">全部红框</span>
        ${zStats
          .map((s) => {
            if (s.skipped)
              return `<span class="chip" style="opacity:.45" data-tc-zone="${escapeHtml(
                s.zone || ""
              )}">${escapeHtml(s.label || s.zone)}·空</span>`;
            const need = (s.diff || 0) + (s.unmatched || 0);
            const on = tcZone === s.zone;
            return `<span class="chip ${on ? "on" : ""}" data-tc-zone="${escapeHtml(
              s.zone || ""
            )}" title="一致${s.aligned || 0}/字差${s.diff || 0}/未对上${
              s.unmatched || 0
            }">${escapeHtml(s.label || s.zone)} ${need ? "⚠" + need : "✓"}</span>`;
          })
          .join("")}
      </div>`
      : "";
  const roiHtml = renderRedBoxStrip(t, labelA, labelB);
  host.innerHTML = `
    <div class="tc-top">
      <span class="tc-verdict ${vOk ? "ok" : "warn"}">${escapeHtml(verdict)}</span>
      <h2>${escapeHtml(productLab)} · ${escapeHtml(t.title || "")} · ${
        hasRoi ? "红框并排" : "阅读序"
      }</h2>
      <p class="tc-headline">${escapeHtml(
        brief.headline ||
          (hasRoi
            ? "两面同一套红框：框内 OCR 后比多/少/错字；跨框不互比。左=「" +
              labelA +
              "」· 右=「" +
              labelB +
              "」。点红框筛选；按 #序号 改稿。"
            : "阅读序比对。左=「" +
              labelA +
              "」· 右=「" +
              labelB +
              "」。真字差/真未对上须人审。")
      )}</p>
      ${bullets}
      ${roiHtml}
      ${zoneBar}
      <div class="tc-meta">${escapeHtml(src)}${
        brief.model ? " · " + escapeHtml(brief.model) : ""
      } · 共 ${counts.all} 行${
        hasRoi ? "（当前红框内）" : ""
      }· 需审 ${counts.need}（字差 ${counts.diff} · 未对上 ${
        counts.miss
      }）· 一致 ${counts.ok}</div>
    </div>
    <div class="tc-filter-bar">
      ${[
        ["all", `全部 ${counts.all}`],
        ["need", `需审核 ${counts.need}`],
        ["diff", `字差 ${counts.diff}`],
        ["miss", `未对上 ${counts.miss}`],
        ["ok", `一致 ${counts.ok}`],
        ["md", `MD/红框`],
      ]
        .map(
          ([k, lab]) =>
            `<span class="chip ${tcFilter === k ? "on" : ""}" data-tc-f="${k}">${lab}</span>`
        )
        .join("")}
    </div>
    ${
      tcFilter === "md"
        ? `<div class="tc-card tc-md"><pre class="tc-md-pre">${escapeHtml(
            t.compare_md ||
              (t.hits || []).find((h) => h.compare_md)?.compare_md ||
              "暂无 MD（请重建任务）"
          )}</pre></div>`
        : `<div class="tc-table-wrap">
      <div class="tc-table-head">
        <div>序/状态</div>
        <div>${escapeHtml(labelA)}</div>
        <div>${escapeHtml(labelB)}</div>
      </div>
      ${rows}
    </div>`
    }
  `;

  host.querySelectorAll("[data-tc-f]").forEach((c) => {
    c.onclick = () => {
      window.__tcFilter = c.getAttribute("data-tc-f");
      renderTextComparePane(t);
    };
  });
  host.querySelectorAll("[data-tc-zone]").forEach((c) => {
    c.onclick = () => {
      window.__tcZone = c.getAttribute("data-tc-zone") || "all";
      window.__tcFilter = "all";
      renderTextComparePane(t);
    };
  });
  host.querySelectorAll("[data-roi-zone]").forEach((box) => {
    box.onclick = (e) => {
      e.stopPropagation();
      const z = box.getAttribute("data-roi-zone") || "all";
      window.__tcZone = window.__tcZone === z ? "all" : z;
      window.__tcFilter = "all";
      renderTextComparePane(t);
    };
  });
  host.querySelectorAll("[data-d]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      decide(btn.dataset.id, btn.dataset.d);
    };
  });
}

function renderReview() {
  const t = currentTask;
  $("rvTitle").textContent = t.title || "任务";
  $("rvBadge").textContent = t.status;
  const s = t.summary || {};
  const todoN = pendingTodoHits(t.hits || []).length;
  const textCmp = isPdfTextCompareTask(t);
  // 文字对比：全宽一一对应，隐藏右栏
  document.querySelector(".main-grid")?.classList.toggle("is-text-compare", !!textCmp);
  // C 端只保留摘要计数，不堆引擎/渲染技术信息
  if (textCmp) {
    const pairs = buildTextComparePairs(t);
    const cd = pairs.filter((p) => p.kind === "diff").length;
    const missN = pairs.filter((p) => p.kind === "miss").length;
    const okN = pairs.filter((p) => p.kind === "ok").length;
    const ens = (t.ocr_meta && t.ocr_meta.ensemble) || {};
    const dz = (t.zone_pipeline || (t.ocr_meta && t.ocr_meta.dual_zone) || {});
    const ensTip =
      ens.ok != null
        ? ` · 多OCR${ens.ok ? "交叉已开" : "交叉未完成"}${
            ens.rescued_false_miss
              ? ` · 假未对上回收${ens.rescued_false_miss}`
              : ""
          }`
        : "";
    const zoneTip = dz.ok
      ? " · 分区ROI已开"
      : dz.mode === "fallback_fullpage"
        ? " · 全页回退"
        : "";
    $("rvMetrics").innerHTML = `双页文案对比 · 共 <b>${pairs.length}</b> 行 · 字差 <b>${cd}</b> · 未对上 <b>${missN}</b> · 一致 <b>${okN}</b>${zoneTip}${ensTip}${
      todoN ? ` · 待处理 <b>${todoN}</b>` : ""
    }`;
  } else {
    $("rvMetrics").innerHTML = `一致 <b>${s["一致"] || 0}</b> · 疑点 <b>${s["疑点"] || 0}</b> · 缺失 <b>${s["缺失"] || 0}</b>${
      todoN ? ` · 待处理 <b>${todoN}</b>` : ""
    }`;
  }

  // 旧引擎任务横幅
  let banner = $("engineBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "engineBanner";
    banner.className = "engine-banner hidden";
    $("view-review")?.querySelector(".review-bar")?.after(banner);
  }
  if (t.type === "excel_pdf") {
    const ver = t.engine_version || "";
    const stale = !ver || ver < TVT_ENGINE_MIN;
    banner.classList.toggle("hidden", !stale);
    if (stale) {
      banner.innerHTML = `<strong>匹配引擎已升级（${TVT_ENGINE_MIN}）</strong>
        当前任务 ${ver || "旧版/无版本"} 不会自动重算整段框与字符 diff。
        请<strong>重新从样本库/新建</strong>跑一遍以获得成分分步、整段定位与反向检查。`;
    }
  } else {
    banner.classList.add("hidden");
  }

  // Word 下载
  const hasDocx = !!(t.docx_url || t.type === "report_summary");
  $("btnDocx").classList.toggle("hidden", !hasDocx);
  // 百度文档比对报告
  const bd = t.baidu_diff || {};
  $("btnBaiduDiff").classList.toggle("hidden", !bd.report_url);
  $("btnBaiduDiff").dataset.report = bd.report_url || "";
  $("btnBaiduSdk").classList.toggle("hidden", !bd.sdk_url);
  $("btnBaiduSdk").dataset.sdk = bd.sdk_url || "";
  // 文字对比：隐藏图形 diff；其它双 PDF 仍可开图形 diff（可选）
  $("btnGraphicsDiff")?.classList.toggle(
    "hidden",
    textCmp || !((t.pages_b || []).length && (t.pages || []).length)
  );
  $("btnTextSummary")?.classList.toggle("hidden", !textCmp);
  $("btnAiReview").classList.toggle(
    "hidden",
    t.type === "report_summary" || textCmp
  );
  $("btnTypoCheck")?.classList.toggle("hidden", textCmp);
  $("btnZoomOut")?.classList.toggle("hidden", !!textCmp);
  $("btnZoomIn")?.classList.toggle("hidden", !!textCmp);
  $("btnZoomReset")?.classList.toggle("hidden", !!textCmp);
  $("btnFullscreen")?.classList.toggle("hidden", !!textCmp);
  $("zoomLabel")?.classList.toggle("hidden", !!textCmp);

  const hasB = hasDualPages(t);
  const excelMode = isExcelPdfTask(t);
  const multiSurf = excelMode && !!t.multi_surface && hasB;
  const pagesA = normalizePages(t.pages);
  const pagesB = normalizePages(t.pages_b || []);
  const pages = sideAB === "b" && hasB ? pagesB : pagesA;
  const labelA = t.label_a || "A";
  const labelB = t.label_b || "B";

  // 文字对比：不显示 A/B 图模式条
  $("viewModeBar")?.classList.toggle("hidden", !hasB || textCmp);
  $("btnSyncPan")?.classList.toggle("hidden", !hasB || multiSurf || textCmp);
  const foot = $("reviewFooterNote");
  if (foot) {
    foot.textContent = textCmp
      ? "文字对比：主看真字差对照 · 分面提示可忽略 · AI 归纳仅展示不改判定。"
      : multiSurf
        ? "三栏：左花盒 · 中确认单 · 右膜袋。点字段定位对应面。AI 仅标疑点。"
        : excelMode
          ? "Excel↔包装：点字段 → 确认单原文 + 包装定位。AI 仅标疑点，须逐条人审。"
          : hasB
            ? "双稿对比：同步平移可开。AI 仅标疑点，须逐条人审。禁止一键全部通过。"
            : "AI 仅标疑点。疑点/缺失须逐条处理。禁止一键全部通过。";
  }
  document.querySelectorAll(".mode-chip").forEach((c) => {
    c.classList.toggle("on", c.dataset.mode === viewMode);
    c.onclick = () => {
      if (textCmp) return;
      viewMode = c.dataset.mode;
      renderReview();
    };
  });

  let tabsHtml = "";
  if (textCmp) {
    tabsHtml = `<span class="muted" style="margin-right:8px">文字对比 · ${escapeHtml(labelA)} ↔ ${escapeHtml(labelB)}</span>`;
  } else if (hasB && viewMode === "single") {
    tabsHtml += `<span class="page-tab ${sideAB === "a" ? "on" : ""}" data-side="a">${escapeHtml(labelA)}</span>`;
    tabsHtml += `<span class="page-tab ${sideAB === "b" ? "on" : ""}" data-side="b">${escapeHtml(labelB)}</span>`;
    tabsHtml += `<span style="width:8px"></span>`;
  }
  if (!textCmp && hasB && viewMode === "compare") {
    tabsHtml += multiSurf
      ? `<span class="muted" style="margin-right:8px">${escapeHtml(labelA)} | 确认单 | ${escapeHtml(labelB)}</span>`
      : `<span class="muted" style="margin-right:8px">${escapeHtml(labelA)} | ${escapeHtml(labelB)}</span>`;
  }
  if (!textCmp) {
    const pageSource = hasB && viewMode === "compare" ? pagesA : pages;
    tabsHtml += pageSource
      .map(
        (_, i) =>
          `<span class="page-tab ${i === pageIdx ? "on" : ""}" data-i="${i}">页 ${i + 1}</span>`
      )
      .join("");
  }
  $("pageTabs").innerHTML = tabsHtml;
  $("pageTabs").querySelectorAll("[data-side]").forEach((tab) => {
    tab.onclick = () => {
      sideAB = tab.dataset.side;
      pageIdx = 0;
      selectedHitId = null;
      renderReview();
    };
  });
  $("pageTabs").querySelectorAll("[data-i]").forEach((tab) => {
    tab.onclick = () => {
      pageIdx = Number(tab.dataset.i);
      selectedHitId = null;
      renderReview();
    };
  });

  const sumPane = $("summaryPane");
  const vs = $("viewerSingle");
  const vc = $("viewerCompare");
  const tcp = $("textComparePane");
  const isReport = t.type === "report_summary" || t.report_summary;
  const page = pages[pageIdx];

  if (textCmp) {
    vs?.classList.add("hidden");
    vc?.classList.add("hidden");
    sumPane?.classList.add("hidden");
    tcp?.classList.remove("hidden");
    if (window.ViewerOSD) ViewerOSD.destroyAll();
    renderTextComparePane(t);
    $("highlightInfo").textContent =
      "文字对比工作台 · 无图 · 点真字差或右侧条目审阅";
  } else if (isReport && !page && !(pagesA.length)) {
    vs?.classList.add("hidden");
    vc?.classList.add("hidden");
    tcp?.classList.add("hidden");
    sumPane.classList.remove("hidden");
    if (window.ViewerOSD) ViewerOSD.destroyAll();
    renderSummaryPane(t);
    $("highlightInfo").textContent = "报告摘要 · 可下载 Word";
  } else {
    sumPane.classList.add("hidden");
    tcp?.classList.add("hidden");
    if (hasB && viewMode === "compare") {
      vs?.classList.add("hidden");
      vc?.classList.remove("hidden");
      $("compareLabelA").textContent = labelA;
      $("compareLabelB").textContent = labelB;
      if (multiSurf) {
        // 三栏：左花盒 · 中确认单 · 右膜袋
        $("excelDetailHost")?.classList.add("hidden");
        $("singleWithDetail")?.classList.remove("is-excel-pdf");
        vc.classList.add("is-excel-triple");
        $("highlightInfo").textContent = `三栏 ${labelA} | 确认单 | ${labelB} · 点字段定位对应面`;
        const cur =
          (t.hits || []).find((h) => h.id === selectedHitId) || null;
        renderExcelFieldPanel(cur);
      } else {
        vc.classList.remove("is-excel-triple");
        $("excelDetailHostMid")?.classList.add("hidden");
        $("excelDetailHost")?.classList.add("hidden");
        $("singleWithDetail")?.classList.remove("is-excel-pdf");
        $("highlightInfo").textContent =
          "双稿对比 · 点待处理 → A/B 框 + 自动放大";
      }
    } else {
      vs?.classList.remove("hidden");
      vc?.classList.add("hidden");
      vc?.classList.remove("is-excel-triple");
      $("excelDetailHostMid")?.classList.add("hidden");
      if (excelMode) {
        $("highlightInfo").textContent =
          "Excel↔包装 · 点右侧字段：确认单原文 · 包装定位高亮";
        const cur =
          (t.hits || []).find((h) => h.id === selectedHitId) || null;
        renderExcelFieldPanel(cur);
      } else {
        $("excelDetailHost")?.classList.add("hidden");
        $("singleWithDetail")?.classList.remove("is-excel-pdf");
        $("highlightInfo").textContent =
          "点字段高亮并放大命中区域";
      }
    }
    // 异步打开 OSD
    openOsdForCurrentPages().catch((e) => {
      console.error(e);
      toast("图片查看器加载失败：" + (e.message || e));
    });
  }

  // 文字对比：无右侧列表（全宽一一对应表内完成）
  if (textCmp) {
    $("filters").innerHTML = "";
    $("hitList").innerHTML = "";
    if ($("reviewFooterNote")) $("reviewFooterNote").textContent = "";
    return;
  }

  const hits = t.hits || [];
  const bucketLabel = {
    typo: "真漏字",
    ocr_unclear: "看不清",
    branch: "规格分支",
    noise: "噪声",
    reverse: "反向多出",
    coverage: "条款/覆盖",
  };
  const counts = {
    all: hits.length,
    todo: hits.filter((h) => ["疑点", "缺失"].includes(h.status) && h.decision === "pending").length,
    warn: hits.filter((h) => h.status === "疑点").length,
    miss: hits.filter((h) => h.status === "缺失").length,
    done: hits.filter((h) => h.decision !== "pending").length,
    typo: hits.filter((h) => h.doubt_bucket === "typo").length,
    coverage: hits.filter((h) => h.doubt_bucket === "coverage").length,
    ocr_unclear: hits.filter((h) => h.doubt_bucket === "ocr_unclear").length,
    branch: hits.filter((h) => h.doubt_bucket === "branch").length,
    noise: hits.filter((h) => h.doubt_bucket === "noise" || h.doubt_bucket === "reverse").length,
    chardiff: hits.filter(isCharDiffHit).length,
    face: hits.filter((h) => h.category === "face_split").length,
    aligned: hits.filter((h) => h.category === "aligned").length,
  };

  const filterChips = [
    ["all", `全部 ${counts.all}`],
    ["todo", `待处理 ${counts.todo}`],
    ["warn", `疑点 ${counts.warn}`],
    ["miss", `缺失 ${counts.miss}`],
    ["coverage", `条款/漏印 ${counts.coverage}`],
    ["typo", `真漏字 ${counts.typo}`],
    ["ocr_unclear", `看不清 ${counts.ocr_unclear}`],
    ["branch", `规格 ${counts.branch}`],
    ["noise", `噪声/反向 ${counts.noise}`],
    ["done", `已处理 ${counts.done}`],
  ];

  $("filters").innerHTML = filterChips
    .map(
      ([k, label]) =>
        `<span class="chip ${filter === k ? "on" : ""}" data-f="${k}">${label}</span>`
    )
    .join("");
  $("filters").querySelectorAll(".chip").forEach((c) => {
    c.onclick = () => {
      filter = c.dataset.f;
      renderReview();
    };
  });

  let list = hits.slice();
  if (filter === "todo")
    list = list.filter((h) => ["疑点", "缺失"].includes(h.status) && h.decision === "pending");
  if (filter === "warn") list = list.filter((h) => h.status === "疑点");
  if (filter === "miss") list = list.filter((h) => h.status === "缺失");
  if (filter === "done") list = list.filter((h) => h.decision !== "pending");
  if (filter === "typo") list = list.filter((h) => h.doubt_bucket === "typo");
  if (filter === "coverage") list = list.filter((h) => h.doubt_bucket === "coverage");
  if (filter === "ocr_unclear") list = list.filter((h) => h.doubt_bucket === "ocr_unclear");
  if (filter === "branch") list = list.filter((h) => h.doubt_bucket === "branch");
  if (filter === "noise")
    list = list.filter((h) => h.doubt_bucket === "noise" || h.doubt_bucket === "reverse");
  if (filter === "chardiff") list = list.filter(isCharDiffHit);
  if (filter === "face") list = list.filter((h) => h.category === "face_split");
  if (filter === "aligned") list = list.filter((h) => h.category === "aligned");

  const order = { 缺失: 0, 疑点: 1, 一致: 2, 跳过: 3 };
  list.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  $("hitList").innerHTML =
    list
      .map((h) => {
        const cls =
          h.status === "缺失" ? "miss" : h.status === "疑点" ? "warn" : h.status === "一致" ? "ok" : "";
        const tag =
          h.decision !== "pending"
            ? `<span class="tag done">${h.decision}${h.decided_by ? " · " + h.decided_by : ""}</span>`
            : `<span class="tag ${h.status === "缺失" ? "miss" : h.status === "疑点" ? "warn" : "ok"}">${h.status}</span>`;
        const bucket = h.doubt_bucket
          ? `<span class="tag bucket b-${escapeHtml(h.doubt_bucket)}">${escapeHtml(
              bucketLabel[h.doubt_bucket] || h.doubt_bucket
            )}</span>`
          : "";
        const boxes = h.bboxes || [];
        const boxesB = h.bboxes_b || [];
        const nBox = boxes.length + boxesB.length;
        const noBbox = h.no_bbox || nBox === 0;
        const cov = h.coverage;
        const covHint =
          cov && cov.total
            ? `<div class="bbox-hint cov">覆盖 ${cov.matched}/${cov.total}${
                cov.miss && cov.miss.length
                  ? " · 未见：" + escapeHtml(cov.miss.slice(0, 3).join("、"))
                  : ""
              }${h.ocr_prob != null ? " · OCR置信 " + Number(h.ocr_prob).toFixed(2) : ""}${
                h.zone_scope ? " · " + escapeHtml(h.zone_scope) : ""
              }</div>`
            : h.ocr_prob != null
              ? `<div class="bbox-hint cov">OCR置信 ${Number(h.ocr_prob).toFixed(2)}</div>`
              : "";
        const bboxHint = isPdfTextCompareTask()
          ? h.category === "face_split"
            ? `<div class="bbox-hint">分面提示 · 不按漏印</div>`
            : isCharDiffHit(h)
              ? `<div class="bbox-hint">真字差 · 见左侧对照</div>`
              : `<div class="bbox-hint muted">文字条目</div>`
          : nBox > 0
            ? `<div class="bbox-hint">📍 ${nBox} 处坐标${h.bbox_source ? " · " + escapeHtml(h.bbox_source) : ""} · 页 ${h.page || boxes[0]?.page || "?"} · 点击高亮</div>`
            : `<div class="bbox-hint no-bbox">无图坐标 · 看文字 diff${
                h.report_url || h.sdk_url || currentTask?.baidu_diff?.report_url
                  ? " · 建议打开百度比对"
                  : ""
              }</div>`;
        const ar = h.ai_review;
        const vlm = h.vlm_typo;
        const aiBox = ar
          ? `<div class="ai-box">
              <div class="ai-head">
                <span>AI 复核 L2 · ${escapeHtml(ar.verdict || "?")}</span>
                <span>${ar.confidence != null ? (Number(ar.confidence) * 100).toFixed(0) + "%" : ""} · 建议 ${escapeHtml(
                    { confirm: "确认一致", issue: "标为问题", pending: "仍需人看" }[
                      ar.suggested_decision
                    ] || ar.suggested_decision || ""
                  )}</span>
              </div>
              <div class="ai-reason">${escapeHtml(ar.reason || "")}</div>
              ${
                h.decision === "pending" && ar.suggested_decision && ar.suggested_decision !== "pending"
                  ? `<div class="ai-actions"><button class="btn primary small" data-apply="${h.id}" data-sug="${ar.suggested_decision}">采纳建议</button></div>`
                  : `<div class="muted" style="font-size:11px;margin-top:4px">L2 不自动过审 · 请结合左图人判</div>`
              }
            </div>`
          : "";
        const vlmBox = vlm
          ? `<div class="ai-box" style="border-color:#a78bfa;background:#f5f3ff">
              <div class="ai-head"><span>漏字 L3 · ${escapeHtml(vlm.verdict || "?")}</span>
              <span>${escapeHtml(vlm.suggested_decision || "")}</span></div>
              <div class="ai-reason">${escapeHtml(vlm.reason || "")}</div>
            </div>`
          : "";
        const surfTag = h.surface
          ? `<span class="tag" style="background:#e0e7ff;color:#3730a3">${escapeHtml(h.surface)}</span>`
          : "";
        const bdUrl = h.report_url || h.sdk_url || currentTask?.baidu_diff?.report_url || "";
        const sdkUrl = h.sdk_url || currentTask?.baidu_diff?.sdk_url || "";
        const bdLink =
          noBbox && (bdUrl || sdkUrl)
            ? `<div class="bbox-hint">
                ${bdUrl ? `<a href="${escapeHtml(bdUrl)}" target="_blank" rel="noopener">百度比对报告</a>` : ""}
                ${sdkUrl ? ` · <a href="#" data-sdk="${escapeHtml(sdkUrl)}">比对 SDK</a>` : ""}
              </div>`
            : h.report_url || h.sdk_url
              ? `<div class="bbox-hint"><a href="${escapeHtml(h.report_url || h.sdk_url)}" target="_blank" rel="noopener">打开百度比对报告 / SDK</a></div>`
              : "";
        const nCheck =
          (boxes || []).filter((b) => b.role === "check" || b.role === "miss_anchor")
            .length +
          (boxesB || []).filter((b) => b.role === "check" || b.role === "miss_anchor")
            .length;
        const nHit =
          (boxes || []).filter((b) => !b.role || b.role === "hit").length +
          (boxesB || []).filter((b) => !b.role || b.role === "hit").length;
        const dualLegend =
          nBox > 0
            ? `<div class="bbox-legend" style="margin:4px 0 0">
                ${nHit ? `<span class="lg-hit">蓝·命中${nHit}</span>` : ""}
                ${nCheck ? `<span class="lg-check">黄·差异${nCheck}</span>` : ""}
              </div>`
            : "";
        const abText =
          h.text_b || (h.excel_value && String(h.excel_value).includes("\nB:"))
            ? `<div class="evidence ab-diff">${escapeHtml(
                (h.excel_value || "").slice(0, 280)
              )}${
                h.text_b && !String(h.excel_value || "").includes(h.text_b.slice(0, 20))
                  ? "\nB: " + escapeHtml(String(h.text_b).slice(0, 160))
                  : ""
              }</div>`
            : `<div class="evidence">${escapeHtml(h.evidence || "")}\n${
                isExcelPdfTask()
                  ? "Excel：" + escapeHtml((h.excel_value || "").slice(0, 200))
                  : escapeHtml((h.excel_value || "").slice(0, 220))
              }${
                h.remark ? "\n备注：" + escapeHtml(String(h.remark).slice(0, 100)) : ""
              }</div>`;
        const actions =
          h.decision === "pending" && can("decide")
            ? `<div class="actions">
                <button class="btn ok" data-d="confirm" data-id="${h.id}">确认一致</button>
                <button class="btn miss" data-d="issue" data-id="${h.id}">标为问题</button>
                <button class="btn" data-d="ignore" data-id="${h.id}">忽略</button>
                <button class="btn primary" data-next-todo data-id="${h.id}" type="button">下一个</button>
              </div>`
            : h.decision !== "pending" && can("decide")
              ? `<div class="actions">
                  <button class="btn" data-d="pending" data-id="${h.id}">改判</button>
                  <button class="btn primary" data-next-todo data-id="${h.id}" type="button">下一个</button>
                </div>`
              : `<div class="actions"><span class="muted" style="font-size:12px">只读 · 无审批权限</span></div>`;
        return `<div class="row ${cls} ${noBbox ? "row-no-bbox" : ""} ${selectedHitId === h.id ? "selected" : ""}" data-hit="${h.id}">
          <div class="head"><span>${escapeHtml(h.field)}</span>${tag}${bucket}${surfTag}</div>
          ${bboxHint}
          ${dualLegend}
          ${covHint}
          ${bdLink}
          ${aiBox}
          ${vlmBox}
          ${abText}
          <div class="muted" style="font-size:11px;margin-top:4px">${escapeHtml(
            (h.evidence || "").slice(0, 180)
          )}</div>
          ${actions}
        </div>`;
      })
      .join("") || `<div class="card"><p>当前筛选下无条目</p></div>`;

  $("hitList").querySelectorAll(".row[data-hit]").forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest("[data-d]") || e.target.closest("[data-next-todo]")) return;
      selectHit(row.dataset.hit);
    };
  });
  $("hitList").querySelectorAll("[data-d]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      decide(btn.dataset.id, btn.dataset.d);
    };
  });
  $("hitList").querySelectorAll("[data-next-todo]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      goNextTodo(btn.dataset.id);
    };
  });
  $("hitList").querySelectorAll("[data-apply]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      decide(btn.dataset.apply, btn.dataset.sug);
    };
  });
  $("hitList").querySelectorAll("[data-sdk]").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = a.getAttribute("data-sdk");
      if (!url) return;
      $("sdkFrame").src = url;
      $("sdkModal").classList.remove("hidden");
    };
  });

  drawHighlights();
}

function selectHit(hitId) {
  selectedHitId = hitId;
  const hit = (currentTask.hits || []).find((h) => h.id === hitId);
  if (!hit) return;

  // 文字对比：无右栏，表内操作即可
  if (isPdfTextCompareTask(currentTask)) {
    renderTextComparePane(currentTask);
    $("highlightInfo").textContent = `一一对应 · ${hit.field || ""} · ${hit.status || ""}`;
    return;
  }

  const dual = hasDualPages(currentTask);
  const excelMode = isExcelPdfTask();
  const multiSurf = isExcelMultiSurface();
  const pagesA = normalizePages(currentTask.pages);
  const pagesB = normalizePages(currentTask.pages_b || []);
  const targetPage =
    hit.page || (hit.bboxes && hit.bboxes[0] && hit.bboxes[0].page) || 1;
  let needOpen = false;

  // Excel 双面：保持三栏 compare，不切单图
  if (multiSurf) {
    if (viewMode !== "compare") {
      viewMode = "compare";
      needOpen = true;
    }
    const wantB =
      hit.surface === (currentTask.label_b || "") || hit.surface === "膜袋";
    sideAB = wantB ? "b" : "a";
  } else if (dual && !excelMode) {
    if (viewMode !== "compare") {
      viewMode = "compare";
      needOpen = true;
    }
    const idx = pagesA.findIndex((p) => p.page === targetPage);
    if (idx >= 0 && idx !== pageIdx && pagesA.length > 1) {
      pageIdx = idx;
      needOpen = true;
    }
  } else {
    if (viewMode !== "single") {
      viewMode = "single";
      needOpen = true;
    }
    const pages = sideAB === "b" && pagesB.length ? pagesB : pagesA;
    const idx = pages.findIndex((p) => p.page === targetPage);
    if (idx >= 0 && idx !== pageIdx) {
      pageIdx = idx;
      needOpen = true;
    }
  }

  const afterReady = async () => {
    document.querySelectorAll(".row").forEach((r) => {
      r.classList.toggle("selected", r.dataset.hit === hitId);
    });
    // 三栏：高亮当前面
    $("comparePaneA")?.classList.toggle("is-focus", multiSurf && sideAB === "a");
    $("comparePaneB")?.classList.toggle("is-focus", multiSurf && sideAB === "b");

    drawHighlights();
    const boxes = hit.bboxes || [];
    const boxesB = hit.bboxes_b || [];
    // 疑点优先聚焦黄框（check），否则聚焦全部命中
    const preferFocus = (list) => {
      const checks = (list || []).filter(
        (b) => b.role === "check" || b.role === "miss_anchor"
      );
      return checks.length ? checks : list || [];
    };
    const focusA = preferFocus(boxes);
    const focusB = preferFocus(boxesB);
    if (window.ViewerOSD) {
      if (multiSurf) {
        if (sideAB === "b") {
          ViewerOSD.focusHit([], focusB, { padRatio: 0.55 });
          if (focusB.length) ViewerOSD.focusBoxes?.("b", focusB, { padRatio: 0.55 });
        } else {
          ViewerOSD.focusHit(focusA, [], { padRatio: 0.55 });
        }
      } else {
        ViewerOSD.focusHit(focusA, focusB, { padRatio: 0.6 });
      }
    }
    if (excelMode) {
      await renderExcelFieldPanel(hit);
      requestAnimationFrame(() => {
        window.ViewerOSD?.resize();
        if (multiSurf && boxes.length) {
          if (sideAB === "b") ViewerOSD.focusBoxes?.("b", boxes, { padRatio: 0.55 });
          else ViewerOSD.focusBoxes?.("a", boxes, { padRatio: 0.55 });
        } else if (boxes.length) {
          ViewerOSD.focusHit(boxes, [], { padRatio: 0.55 });
        }
      });
      const n = boxes.length;
      const surf = hit.surface ? ` · ${hit.surface}` : "";
      const missN = (hit.coverage && hit.coverage.miss && hit.coverage.miss.length) || 0;
      const checkN = (boxes || []).filter((b) => b.role === "check").length;
      const tip =
        hit.status === "疑点" || hit.status === "缺失"
          ? checkN
            ? ` · 黄框=建议核对点${missN ? "（确认单有、写法可能不同）" : ""}`
            : missN
              ? ` · 请对照确认单未见项 ${missN} 条`
              : ""
          : "";
      $("highlightInfo").textContent = multiSurf
        ? `三栏 · 「${hit.field}」${surf} · 中栏确认单 · ${n ? n + " 框已放大" : "无坐标"}${tip}`
        : n
          ? `「${hit.field}」${surf} · Excel 已展开 · 包装 ${n} 框${tip}`
          : `「${hit.field}」${surf} · Excel 已展开 · 无坐标${tip}`;
    } else {
      const n = boxes.length + boxesB.length;
      if (n) {
        $("highlightInfo").textContent = `命中「${hit.field}」· ${n} 框 · 已放大${
          dual ? " · A/B 双侧" : ""
        }`;
      } else {
        $("highlightInfo").textContent = `「${hit.field}」· 无图坐标 · 请看文字 diff`;
        if (hit.category === "baidu_diff" || hit.ux_hint === "open_baidu_report") {
          toast("该差异无图坐标：可打开百度比对报告查看官方高亮");
        }
      }
    }
  };

  if (needOpen) {
    selectedHitId = hitId;
    renderReview();
    setTimeout(() => afterReady(), 550);
  } else {
    afterReady();
  }
}

function hitsToDraw() {
  const hits = currentTask?.hits || [];
  if (selectedHitId) {
    const h = hits.find((x) => x.id === selectedHitId);
    return h ? [h] : [];
  }
  return hits.filter(
    (h) =>
      ((h.bboxes || []).length || (h.bboxes_b || []).length) &&
      ["疑点", "缺失"].includes(h.status)
  );
}

function drawHighlights() {
  if (!currentTask || !window.ViewerOSD) return;
  ViewerOSD.clearAllOverlays();
  const toDraw = hitsToDraw();
  const dual = hasDualPages(currentTask) && viewMode === "compare";
  const multiSurf = isExcelMultiSurface() && viewMode === "compare";

  if (dual) {
    // 汇总 A/B 框：选中时只画选中；否则画全部疑点
    if (selectedHitId) {
      const h = toDraw[0];
      if (!h) return;
      const st = statusClass(h.status);
      if (multiSurf) {
        // 花盒/膜袋：bboxes 只在对应面
        const onB =
          h.surface === (currentTask.label_b || "") || h.surface === "膜袋";
        ViewerOSD.setOverlays(onB ? "b" : "a", h.bboxes || [], {
          selected: true,
          label: h.field,
          status: st,
        });
        ViewerOSD.setOverlays(onB ? "a" : "b", [], {});
        return;
      }
      ViewerOSD.setOverlays("a", h.bboxes || [], {
        selected: true,
        label: h.field,
        status: st,
      });
      ViewerOSD.setOverlays("b", h.bboxes_b || [], {
        selected: true,
        label: h.field,
        status: st,
      });
    } else {
      // 合并所有疑点框（限量）
      const boxesA = [];
      const boxesB = [];
      toDraw.slice(0, 30).forEach((h) => {
        if (multiSurf) {
          const onB =
            h.surface === (currentTask.label_b || "") || h.surface === "膜袋";
          (h.bboxes || []).forEach((b) => (onB ? boxesB : boxesA).push(b));
        } else {
          (h.bboxes || []).forEach((b) => boxesA.push(b));
          (h.bboxes_b || []).forEach((b) => boxesB.push(b));
        }
      });
      ViewerOSD.setOverlays("a", boxesA, { status: "warn" });
      ViewerOSD.setOverlays("b", boxesB, { status: "warn" });
    }
  } else {
    if (selectedHitId) {
      const h = toDraw[0];
      if (!h) return;
      const boxes =
        sideAB === "b" && (h.bboxes_b || []).length ? h.bboxes_b : h.bboxes || [];
      ViewerOSD.setOverlays("s", boxes, {
        selected: true,
        label: h.field,
        status: statusClass(h.status),
      });
    } else {
      const boxes = [];
      toDraw.slice(0, 40).forEach((h) => {
        (h.bboxes || []).forEach((b) => boxes.push(b));
      });
      ViewerOSD.setOverlays("s", boxes, { status: "warn" });
    }
  }
}

async function decide(hitId, decision) {
  try {
    currentTask = await api(`/api/tasks/${currentTask.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        hit_id: hitId,
        decision,
        actor: session.name || "审核员",
      }),
    });
    // 处理后自动跳到下一条待处理（确认/标问题/忽略）
    const autoNext = ["confirm", "issue", "ignore"].includes(decision);
    const nid = autoNext ? nextPendingHitId(hitId, currentTask.hits || []) : null;
    if (nid) {
      selectedHitId = nid;
      renderReview();
      // 等列表渲染后定位
      setTimeout(() => selectHit(nid), 80);
      toast("已记录 · 下一条待处理");
    } else {
      selectedHitId = hitId;
      renderReview();
      if (autoNext) toast("已记录 · 待处理已全部处理完");
    }
  } catch (e) {
    toast(e.message);
  }
}

async function complete() {
  try {
    currentTask = await api(`/api/tasks/${currentTask.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ actor: session.name || "审核员", notify: true }),
    });
    toast(
      "终审完成" +
        (currentTask.feishu_complete?.ok ? " · 已推飞书" : currentTask.feishu_complete ? " · 飞书失败" : "")
    );
    renderReview();
  } catch (e) {
    toast(e.message);
  }
}

function renderSummaryPane(t) {
  const rs = t.report_summary || {};
  const ex = t.extract || {};
  const paras = (rs.paragraphs || [])
    .map((p) => `<p class="para">${escapeHtml(p)}</p>`)
    .join("");
  const claims = (rs.claims || [])
    .map((c) => `<span class="pill blue">${escapeHtml(c)}</span>`)
    .join("");
  const metrics = (rs.key_metrics || [])
    .map((m) => {
      if (typeof m === "string") return `<li>${escapeHtml(m)}</li>`;
      return `<li><strong>${escapeHtml(m.name || "")}</strong> ${escapeHtml(m.value || "")} ${
        m.note ? `<span class="muted">(${escapeHtml(m.note)})</span>` : ""
      }</li>`;
    })
    .join("");
  $("summaryPane").innerHTML = `
    <h2>${escapeHtml(rs.title || t.title || "功效摘要")}</h2>
    <div class="meta">
      ${rs.product_name ? escapeHtml(rs.product_name) + " · " : ""}
      ${rs.report_no ? "报告 " + escapeHtml(rs.report_no) + " · " : ""}
      页 ${ex.start_page || "?"}-${ex.end_page || "?"}
      ${ex.conclusion_page ? " · 结论页 " + ex.conclusion_page : ""}
      · ${escapeHtml(t.engine || "")}
    </div>
    ${paras || "<p class='para muted'>暂无摘要段落</p>"}
    ${claims ? `<h3>功效宣称</h3><div class="claims">${claims}</div>` : ""}
    ${metrics ? `<h3>关键数据</h3><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6">${metrics}</ul>` : ""}
    ${rs.safety ? `<h3>安全性</h3><p class="para">${escapeHtml(rs.safety)}</p>` : ""}
    <p class="meta" style="margin-top:24px">AI 摘抄 · 请对照原文终审后使用</p>
  `;
}

function downloadDocx() {
  if (!currentTask) return;
  const url = currentTask.docx_url || `/api/tasks/${currentTask.id}/docx`;
  window.open(url, "_blank");
}

async function runTextCompareSummary() {
  if (!currentTask || !isPdfTextCompareTask(currentTask)) return;
  if (!can("ai_review")) {
    toast("当前角色无 AI 权限（需审核员/管理员）");
    return;
  }
  loading(true, "正在归纳文字对比结论（约 10–40 秒）…");
  try {
    const res = await api(`/api/tasks/${currentTask.id}/text-compare-summary`, {
      method: "POST",
      body: JSON.stringify({
        actor: session.name || "审核员",
        use_ai: true,
      }),
    });
    if (res.task) currentTask = res.task;
    else if (res.brief) currentTask.text_compare_brief = res.brief;
    renderReview();
    const src = (currentTask.text_compare_brief || {}).source || "";
    toast(
      src === "ai"
        ? "AI 归纳已更新"
        : src === "rule_fallback"
          ? "AI 不可用，已用规则摘要"
          : "摘要已更新"
    );
  } catch (e) {
    toast("归纳失败：" + (e.message || e));
  } finally {
    loading(false);
  }
}

async function runAiReview() {
  if (!currentTask) return;
  if (isPdfTextCompareTask(currentTask)) {
    return runTextCompareSummary();
  }
  if (!session.name && !session.token) {
    toast("请先登录显示名");
    return;
  }
  if (!can("ai_review")) {
    toast("当前角色无 AI 复核权限（需审核员/管理员）");
    return;
  }
  const uncertain = (currentTask.hits || []).filter((h) =>
    ["疑点", "缺失"].includes(h.status)
  );
  if (!uncertain.length) {
    toast("当前没有「疑点/缺失」条目需要 AI 复核");
    return;
  }

  // 体验：分阶段文案 + 超时提示（接口常 30–60s）
  const phases = [
    "准备疑点字段…",
    "调用 MiniMax-M3 语义复核（约 30–60 秒）…",
    "仍在等待模型返回，请勿关闭页面…",
    "即将完成，写入复核建议…",
  ];
  let phase = 0;
  loading(true, phases[0] + `（${uncertain.length} 条）`);
  const tick = setInterval(() => {
    phase = Math.min(phase + 1, phases.length - 1);
    loading(true, phases[phase] + `（${uncertain.length} 条）`);
  }, 12000);

  try {
    currentTask = await api(`/api/tasks/${currentTask.id}/ai-review`, {
      method: "POST",
      body: JSON.stringify({
        actor: session.name || "审核员",
        only_uncertain: true,
        apply_status: false,
      }),
    });
    const n = (currentTask.ai_review_meta || {}).count || 0;
    const withAi = (currentTask.hits || []).filter((h) => h.ai_review);
    // 切到待处理/疑点，方便看见 AI 块
    if (withAi.length) filter = "todo";
    renderReview();
    const firstAi = withAi.find((h) =>
      ["疑点", "缺失"].includes(h.status)
    );
    if (firstAi) {
      setTimeout(() => selectHit(firstAi.id), 300);
    }
    toast(
      n
        ? `AI 已复核 ${n} 条 · 请在右侧字段下查看「AI · 建议」并可点采纳`
        : "模型未返回复核条目（可重试或检查 MiniMax 配置）"
    );
  } catch (e) {
    const msg = e.message || String(e);
    if (/timeout|超时|Failed to fetch|NetworkError/i.test(msg)) {
      toast("AI 复核超时/网络中断：可再点一次；需能访问 MiniMax API");
    } else {
      toast("AI 复核失败：" + msg);
    }
  } finally {
    clearInterval(tick);
    loading(false);
  }
}

function openReport() {
  if (!currentTask) return;
  window.open(`/api/tasks/${currentTask.id}/report`, "_blank");
}

function openReportPdf() {
  if (!currentTask) return;
  window.open(`/api/tasks/${currentTask.id}/report.pdf`, "_blank");
}

async function archiveFeishu() {
  if (!currentTask) return;
  if (!can("archive")) {
    toast("当前角色无归档权限");
    return;
  }
  loading(true, "生成 PDF 并推送飞书…");
  try {
    const r = await api(`/api/tasks/${currentTask.id}/archive/feishu`, { method: "POST" });
    toast(r.ok ? "已归档：PDF + 飞书通知" : "归档部分失败：" + JSON.stringify(r.feishu || r));
    if (r.pdf) window.open(r.pdf, "_blank");
  } catch (e) {
    toast(e.message);
  } finally {
    loading(false);
  }
}

async function runBackup() {
  if (!can("backup")) {
    toast("需要 admin 角色（登录「管理员」）");
    return;
  }
  loading(true, "备份任务 JSON…");
  try {
    const r = await api("/api/ops/backup", { method: "POST" });
    toast(`备份完成：${r.name}（${Math.round((r.size || 0) / 1024)} KB）`);
  } catch (e) {
    toast(e.message);
  } finally {
    loading(false);
  }
}

async function testFeishu() {
  try {
    const r = await api("/api/feishu/test", { method: "POST" });
    toast(r.ok ? "飞书测试消息已发送" : "失败：" + JSON.stringify(r.error || r));
  } catch (e) {
    toast(e.message);
  }
}

/* ========== Events ========== */
document.querySelectorAll("[data-view]").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const v = el.dataset.view;
    if (!v) return;
    showView(v);
    if (v === "home") loadTasks();
    if (v === "presets") loadPresets();
    if (v === "new") setWizStep(wizStep);
    if (v === "audit") loadAudit();
  });
});

$("btnRefresh").onclick = () => loadTasks();
$("btnDeleteTask") &&
  ($("btnDeleteTask").onclick = () => {
    if (!currentTask?.id) {
      toast("没有打开的任务");
      return;
    }
    deleteTask(currentTask.id, currentTask.title || "");
  });
$("btnBack").onclick = () => {
  applySidebar(localStorage.getItem(SIDEBAR_KEY) === "1");
  showView("home");
  // 离开审核时恢复侧栏（若用户未强制折叠）
  if (localStorage.getItem(SIDEBAR_KEY) !== "1") applySidebar(false);
  loadTasks();
};
$("btnComplete").onclick = complete;
$("btnAiReview").onclick = runAiReview;
$("btnTextSummary")?.addEventListener("click", () => runTextCompareSummary());
$("btnTypoCheck")?.addEventListener("click", async () => {
  if (!currentTask) return;
  if (!can("ai_review")) {
    toast("需要审核员权限");
    return;
  }
  loading(true, "第三层漏字确认（MiniMax，约 30–60 秒）…");
  try {
    currentTask = await api(`/api/tasks/${currentTask.id}/typo-check`, {
      method: "POST",
      body: JSON.stringify({ actor: session.name || "审核员" }),
    });
    const n = (currentTask.vlm_typo_meta || {}).count || 0;
    toast(n ? `漏字确认完成 ${n} 条 · 见字段下「漏字 L3」` : "无漏字候选或模型未返回");
    filter = "todo";
    renderReview();
  } catch (e) {
    toast("漏字确认失败：" + e.message);
  } finally {
    loading(false);
  }
});
$("btnReport").onclick = openReport;
$("btnReportPdf")?.addEventListener("click", openReportPdf);
$("btnArchiveFeishu")?.addEventListener("click", archiveFeishu);
$("btnBackup")?.addEventListener("click", runBackup);
$("btnDocx").onclick = downloadDocx;
$("btnBaiduDiff").onclick = () => {
  const url = $("btnBaiduDiff").dataset.report;
  if (url) window.open(url, "_blank");
  else toast("暂无百度比对报告链接");
};
$("btnGraphicsDiff")?.addEventListener("click", async () => {
  if (!currentTask) return;
  loading(true, "A/B 像素 diff…");
  try {
    const r = await api(`/api/tasks/${currentTask.id}/graphics-diff`, {
      method: "POST",
    });
    toast(
      `图形 diff：${r.verdict || "ok"} · 差异 ${(r.diff_ratio * 100).toFixed(2)}%`
    );
    if (r.preview_url) window.open(r.preview_url, "_blank");
  } catch (e) {
    toast(e.message);
  } finally {
    loading(false);
  }
});
$("btnBaiduSdk")?.addEventListener("click", () => {
  const url = $("btnBaiduSdk").dataset.sdk;
  if (!url) {
    toast("暂无百度比对 SDK 链接");
    return;
  }
  $("sdkFrame").src = url;
  $("sdkModal").classList.remove("hidden");
});
$("btnCloseSdk")?.addEventListener("click", () => {
  $("sdkModal").classList.add("hidden");
  $("sdkFrame").src = "about:blank";
});
$("btnLogin").onclick = doLogin;
$("btnLogout").onclick = doLogout;
$("btnFeishuTest").onclick = testFeishu;
$("btnAuditRefresh").onclick = loadAudit;
$("loginName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});

// 侧栏折叠
$("btnSidebarToggle")?.addEventListener("click", () => {
  const now = !$("appRoot").classList.contains("sidebar-collapsed");
  applySidebar(now);
});
$("btnCollapseSidebar")?.addEventListener("click", () => {
  const now = !$("appRoot").classList.contains("sidebar-collapsed");
  applySidebar(now);
});

// 字号密度
document.querySelectorAll(".density-chip").forEach((c) => {
  c.addEventListener("click", () => applyDensity(c.dataset.density));
});

// OpenSeadragon 缩放 / 同步 / 全屏
$("btnZoomIn")?.addEventListener("click", () => {
  if (window.ViewerOSD) ViewerOSD.zoomBy(1.25);
});
$("btnZoomOut")?.addEventListener("click", () => {
  if (window.ViewerOSD) ViewerOSD.zoomBy(0.8);
});
$("btnZoomReset")?.addEventListener("click", () => {
  if (window.ViewerOSD) ViewerOSD.fitHome();
});
$("btnSyncPan")?.addEventListener("click", () => {
  if (!window.ViewerOSD) return;
  const on = !ViewerOSD.getSync();
  ViewerOSD.setSync(on);
  $("btnSyncPan").classList.toggle("is-on", on);
  toast(on ? "已开启双图同步" : "已关闭双图同步");
});
$("btnFullscreen")?.addEventListener("click", async () => {
  const el = $("canvasWrap");
  if (!el) return;
  try {
    if (!document.fullscreenElement) await el.requestFullscreen();
    else await document.exitFullscreen();
    setTimeout(() => window.ViewerOSD?.resize(), 100);
  } catch (e) {
    toast("全屏不可用：" + e.message);
  }
});
// 默认同步按钮高亮
$("btnSyncPan")?.classList.add("is-on");

document.querySelectorAll(".type-card").forEach((card) => {
  card.onclick = () => {
    document.querySelectorAll(".type-card").forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");
    wizType = card.dataset.type;
    wizFiles = { excel: null, pdf: null, pdf_a: null, pdf_b: null };
    wizPackSurface = "carton";
  };
});
$("wizNext1").onclick = () => setWizStep(2);
$("wizBack2").onclick = () => setWizStep(1);
$("wizNext2").onclick = () => {
  if (!validateFiles()) {
    toast("请先选择所需文件");
    return;
  }
  setWizStep(3);
};
$("wizBack3").onclick = () => setWizStep(2);
$("btnSubmitUpload").onclick = submitUpload;

window.addEventListener("resize", () => {
  if (currentTask && !$("view-review").classList.contains("hidden")) {
    window.ViewerOSD?.resize();
    drawHighlights();
  }
});

// init density / sidebar
applyDensity(localStorage.getItem(DENSITY_KEY) || "large");
applySidebar(localStorage.getItem(SIDEBAR_KEY) === "1");

refreshMe();
refreshHealth();
loadTasks();
loadPresets();
renderUser();
