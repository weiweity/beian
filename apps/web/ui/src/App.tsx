import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, type Me } from "./api";
import { authFailureAction, shouldAutoRedirectToFeishu } from "./authGate";
import { Sidebar, type NavKey } from "./chrome/Sidebar";
import { liveNavPulse } from "./pages/waitCard";
import { NewTaskPage } from "./pages/NewTaskPage";
import { ReviewPage } from "./pages/ReviewPage";
import { TasksPage } from "./pages/TasksPage";

const HistoryPage = lazy(() =>
  import("./pages/HistoryPage").then((m) => ({ default: m.HistoryPage })),
);
const MockupPage = lazy(() =>
  import("./pages/MockupPage").then((m) => ({ default: m.MockupPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);

function PaneFallback({ label }: { label: string }) {
  return <p className="boot">{label}</p>;
}

type View = "tasks" | "new" | "review" | "mockup" | "history" | "settings";

const AUTH_HINT = "wb_login_hint";
const SIDEBAR_KEY = "wb_sidebar";
const AUTH_FALLBACK: Record<string, string> = {
  denied: "已取消飞书授权。",
  expired: "登录已过期，请再点一次。",
  forbidden: "只允许伸美公司的飞书号进入。",
  failed: "飞书授权失败，请再试一次。",
};

function readAuthHint(): string {
  const raw = document.cookie.split(";").map((s) => s.trim());
  const hit = raw.find((s) => s.startsWith(`${AUTH_HINT}=`));
  if (!hit) return "";
  const val = decodeURIComponent(hit.slice(AUTH_HINT.length + 1));
  document.cookie = `${AUTH_HINT}=; Path=/; Max-Age=0`;
  return val;
}

function authTitle(message: string): string {
  if (message.includes("伸美") || message.includes("不允许")) return "进不了这间审稿室";
  if (message.includes("取消")) return "授权未完成";
  if (message.includes("过期")) return "登录已过期";
  return "飞书授权未完成";
}

function AuthShell({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="auth-result">
      <img className="auth-result-logo" src="/brand/shine-mage.png" alt="SHINE MAGE" />
      {title ? <h1 className="auth-result-title">{title}</h1> : null}
      {children}
    </div>
  );
}

function navOf(view: View): NavKey {
  if (view === "mockup") return "mockup";
  if (view === "history") return "history";
  if (view === "settings") return "settings";
  return "review";
}

const TASK_DEEPLINK = /^[0-9a-f]{12}$/i;
const TASK_STASH = "wb_open_task";

function readTaskDeeplink(search: string): string | null {
  const raw = new URLSearchParams(search).get("task") || "";
  return TASK_DEEPLINK.test(raw) ? raw.toLowerCase() : null;
}

function stripTaskQuery(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("task");
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`;
}

function stashTaskDeeplink(tid: string) {
  try {
    sessionStorage.setItem(TASK_STASH, tid);
  } catch {
    /* ignore */
  }
}

function takeStashedTask(): string | null {
  try {
    const raw = sessionStorage.getItem(TASK_STASH) || "";
    if (!TASK_DEEPLINK.test(raw)) return null;
    sessionStorage.removeItem(TASK_STASH);
    return raw.toLowerCase();
  } catch {
    return null;
  }
}

function readCollapsed() {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* fall through to viewport */
  }
  return window.matchMedia("(max-width: 1024px)").matches;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>("tasks");
  const [authError, setAuthError] = useState<string | null>(null);
  const [apiBroken, setApiBroken] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [mockupId, setMockupId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [livePulse, setLivePulse] = useState({ review: false, mockup: false });

  const refreshMe = useCallback(async () => {
    try {
      const next = await api.me();
      setMe(next);
      setApiBroken(null);
      if (next.logged_in) {
        const tab = new URLSearchParams(window.location.search).get("tab");
        setView((cur) =>
          cur === "tasks" && (window.location.hash === "#settings" || tab === "settings") ? "settings" : cur,
        );
        setAuthError(null);
      } else {
        setTaskId(null);
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "";
      if (msg.includes("8787") || msg.includes("JSON")) setApiBroken(msg);
      setMe({ logged_in: false, display_name: null, avatar_url: null, role: null, perms: [] });
    }
  }, []);

  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get("feishu_error") || "";
    const tid = readTaskDeeplink(window.location.search);
    if (tid) stashTaskDeeplink(tid);
    if (err) {
      setAuthError(readAuthHint() || AUTH_FALLBACK[err] || "飞书授权未完成。");
      const url = new URL(window.location.href);
      url.searchParams.delete("feishu_error");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
    void refreshMe();
    // 只在进站时拉一次登录态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loggedIn = Boolean(me?.logged_in);

  useEffect(() => {
    if (!loggedIn) return;
    let cancelled = false;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void api
        .health()
        .then((h) => {
          if (cancelled) return;
          const next = liveNavPulse(h);
          setLivePulse((cur) => (cur.review === next.review && cur.mockup === next.mockup ? cur : next));
        })
        .catch(() => undefined);
    };
    tick();
    const id = window.setInterval(tick, 4000);
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loggedIn]);

  useEffect(() => {
    if (me === null) return;
    if (
      !shouldAutoRedirectToFeishu({
        pathname: window.location.pathname,
        loggedIn,
        authError,
        apiBroken,
      })
    ) {
      return;
    }
    window.location.replace("/api/auth/feishu/login");
  }, [me, loggedIn, authError, apiBroken]);

  useEffect(() => {
    if (!loggedIn) return;
    const fromUrl = readTaskDeeplink(window.location.search);
    const tid = fromUrl || takeStashedTask();
    if (!tid) return;
    if (fromUrl) {
      window.history.replaceState({}, "", stripTaskQuery(window.location.href));
      try {
        sessionStorage.removeItem(TASK_STASH);
      } catch {
        /* ignore */
      }
    }
    setTaskId(tid);
    setView("review");
  }, [loggedIn]);

  function toggleSidebar() {
    setCollapsed((cur) => {
      const next = !cur;
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  async function logout() {
    await api.logout();
    window.location.replace("/api/auth/feishu/login");
  }

  function collapsePhoneSheet() {
    if (!window.matchMedia("(max-width: 720px)").matches) return;
    setCollapsed(true);
    try {
      localStorage.setItem(SIDEBAR_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  function go(key: NavKey) {
    if (key === "review") {
      setView("tasks");
      setTaskId(null);
      collapsePhoneSheet();
      return;
    }
    if (key === "mockup") {
      setView("mockup");
      setTaskId(null);
      setMockupId(null);
      collapsePhoneSheet();
      return;
    }
    if (key === "history") {
      setView("history");
      setTaskId(null);
      collapsePhoneSheet();
      return;
    }
    setView("settings");
    collapsePhoneSheet();
  }

  if (me === null) {
    return (
      <AuthShell>
        <p>正在进入…</p>
      </AuthShell>
    );
  }

  if (!loggedIn) {
    if (authError || apiBroken) {
      const message = authError || apiBroken || "";
      const action = authFailureAction({ authError, apiBroken });
      return (
        <AuthShell title={authError ? authTitle(authError) : "进不了这间审稿室"}>
          <p>{message}</p>
          <a className="auth-result-retry" href={action.href}>
            {action.label}
          </a>
        </AuthShell>
      );
    }
    return (
      <AuthShell>
        <p>正在前往飞书授权…</p>
      </AuthShell>
    );
  }

  return (
    <div className="shell">
      <div className="workspace">
        {!collapsed ? (
          <button type="button" className="sidebar-scrim" aria-label="收起侧栏" onClick={toggleSidebar} />
        ) : null}
        <Sidebar
          collapsed={collapsed}
          active={navOf(view)}
          displayName={me.display_name || "飞书用户"}
          avatarUrl={me.avatar_url}
          onNavigate={go}
          onToggle={toggleSidebar}
          onLogout={() => void logout()}
          livePulse={livePulse}
        />
        <main className={view === "settings" ? "stage stage-flush" : "stage"}>
        {view === "settings" ? (
          <Suspense fallback={<PaneFallback label="打开设置…" />}>
            <SettingsPage
              canWrite={Boolean(me.perms.includes("create"))}
              canAdmin={me.role === "admin"}
              openId={me.open_id || ""}
              displayName={me.display_name}
            />
          </Suspense>
        ) : null}
        {view === "mockup" ? (
          <Suspense fallback={<PaneFallback label="打开打样台…" />}>
            <MockupPage openId={mockupId} />
          </Suspense>
        ) : null}
        {view === "history" ? (
          <Suspense fallback={<PaneFallback label="打开历史记录…" />}>
            <HistoryPage
              onOpenTask={(id) => {
                setTaskId(id);
                setView("review");
              }}
              onOpenMockup={(id) => {
                setMockupId(id);
                setView("mockup");
              }}
            />
          </Suspense>
        ) : null}
        {view === "tasks" ? (
          <TasksPage
            onCreate={() => setView("new")}
            onOpen={(id) => {
              setTaskId(id);
              setView("review");
            }}
          />
        ) : null}
        {view === "new" ? (
          <NewTaskPage
            onCreated={(id) => {
              setTaskId(id);
              setView("review");
            }}
            onBack={() => setView("tasks")}
          />
        ) : null}
        {view === "review" ? (
          <ReviewPage
            taskId={taskId}
            onBack={() => {
              setView("tasks");
              setTaskId(null);
            }}
          />
        ) : null}
        </main>
      </div>
    </div>
  );
}
