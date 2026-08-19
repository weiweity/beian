import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Dropdown, Layout } from "antd";
import { ApiError, api, type Me } from "./api";
import { authFailureAction, shouldAutoRedirectToFeishu } from "./authGate";
import { MockupPage } from "./pages/MockupPage";
import { NewTaskPage } from "./pages/NewTaskPage";
import { ReviewPage } from "./pages/ReviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TasksPage } from "./pages/TasksPage";

type Desk = "review" | "mockup";
type View = "tasks" | "new" | "review" | "mockup" | "settings";

const AUTH_HINT = "wb_login_hint";
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

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>("tasks");
  const [authError, setAuthError] = useState<string | null>(null);
  const [apiBroken, setApiBroken] = useState<string | null>(null);
  const [desk, setDesk] = useState<Desk>("review");
  const [taskId, setTaskId] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      const next = await api.me();
      setMe(next);
      setApiBroken(null);
      if (next.logged_in) {
        setView((cur) => (cur === "tasks" && window.location.hash === "#settings" ? "settings" : cur));
        setAuthError(null);
      } else {
        setTaskId(null);
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "";
      if (msg.includes("8787") || msg.includes("JSON")) setApiBroken(msg);
      setMe({ logged_in: false, display_name: null, role: null, perms: [] });
    }
  }, []);

  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get("feishu_error") || "";
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

  async function logout() {
    await api.logout();
    window.location.replace("/api/auth/feishu/login");
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
    <Layout className="shell">
      <header className="topbar">
        <img className="topbar-logo" src="/brand/shine-mage.png" alt="SHINE MAGE" />
        <nav className="topbar-tabs" aria-label="工作台">
          <button
            type="button"
            className={desk === "review" && view !== "settings" ? "topbar-tab is-on" : "topbar-tab"}
            aria-current={desk === "review" && view !== "settings" ? "page" : undefined}
            onClick={() => {
              setDesk("review");
              if (view === "mockup" || view === "settings") setView("tasks");
            }}
          >
            审稿台
          </button>
          <button
            type="button"
            className={desk === "mockup" && view !== "settings" ? "topbar-tab is-on" : "topbar-tab"}
            aria-current={desk === "mockup" && view !== "settings" ? "page" : undefined}
            onClick={() => {
              setDesk("mockup");
              setView("mockup");
              setTaskId(null);
            }}
          >
            打样台
          </button>
        </nav>
        <Dropdown
          trigger={["click"]}
          placement="bottomRight"
          menu={{
            selectedKeys: view === "settings" ? ["settings"] : [],
            items: [
              { key: "settings", label: "设置" },
              { type: "divider" },
              { key: "logout", label: "退出", danger: true },
            ],
            onClick: ({ key }) => {
              if (key === "settings") setView("settings");
              if (key === "logout") void logout();
            },
          }}
        >
          <button
            type="button"
            className={view === "settings" ? "topbar-who is-on" : "topbar-who"}
            aria-haspopup="menu"
          >
            <span>{me?.display_name}</span>
            <span className="topbar-who-caret" aria-hidden>
              ▾
            </span>
          </button>
        </Dropdown>
      </header>
      <Layout.Content className={view === "settings" ? "content content-flush" : "content"}>
        {view === "settings" ? (
          <SettingsPage
            canWrite={Boolean(me?.perms.includes("create"))}
            openId={me?.open_id || ""}
            displayName={me?.display_name}
          />
        ) : null}
        {view !== "settings" && desk === "mockup" ? <MockupPage /> : null}
        {view !== "settings" && desk === "review" && view === "tasks" ? (
          <TasksPage
            onCreate={() => setView("new")}
            onOpen={(id) => {
              setTaskId(id);
              setView("review");
            }}
          />
        ) : null}
        {view !== "settings" && desk === "review" && view === "new" ? (
          <NewTaskPage
            onCreated={(id) => {
              setTaskId(id);
              setView("review");
            }}
          />
        ) : null}
        {view !== "settings" && desk === "review" && view === "review" ? (
          <ReviewPage
            taskId={taskId}
            onBack={() => {
              setView("tasks");
              setTaskId(null);
            }}
          />
        ) : null}
      </Layout.Content>
    </Layout>
  );
}
