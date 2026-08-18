import { useCallback, useEffect, useState } from "react";
import { Button, Layout } from "antd";
import { api, type Me } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { MockupPage } from "./pages/MockupPage";
import { NewTaskPage } from "./pages/NewTaskPage";
import { ReviewPage } from "./pages/ReviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TasksPage } from "./pages/TasksPage";

type Desk = "review" | "mockup";
type View = "login" | "tasks" | "new" | "review" | "mockup" | "settings";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState<View>("login");
  const [desk, setDesk] = useState<Desk>("review");
  const [taskId, setTaskId] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      const next = await api.me();
      setMe(next);
      if (next.logged_in && view === "login") {
        setView("tasks");
        setDesk("review");
      }
      if (!next.logged_in) {
        setView("login");
        setTaskId(null);
      }
    } catch {
      setMe({ logged_in: false, display_name: null, role: null, perms: [] });
      setView("login");
    }
  }, [view]);

  useEffect(() => {
    void refreshMe();
    // 只在进站时拉一次登录态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loggedIn = Boolean(me?.logged_in);

  async function logout() {
    await api.logout();
    setMe({ logged_in: false, display_name: null, role: null, perms: [] });
    setView("login");
    setTaskId(null);
  }

  if (!loggedIn) {
    return <LoginPage onEntered={refreshMe} />;
  }

  return (
    <Layout className="shell">
      <header className="topbar">
        <img className="topbar-logo" src="/brand/logo.png" alt="" />
        <nav className="topbar-tabs">
          <button
            type="button"
            className={desk === "review" ? "topbar-tab is-on" : "topbar-tab"}
            onClick={() => {
              setDesk("review");
              if (view === "mockup" || view === "settings") setView("tasks");
            }}
          >
            审稿台
          </button>
          <button
            type="button"
            className={desk === "mockup" ? "topbar-tab is-on" : "topbar-tab"}
            onClick={() => {
              setDesk("mockup");
              setView("mockup");
              setTaskId(null);
            }}
          >
            打样台
          </button>
        </nav>
        <div className="topbar-who">
          <Button
            type="text"
            size="small"
            className={view === "settings" ? "topbar-settings is-on" : "topbar-settings"}
            onClick={() => setView("settings")}
          >
            设置
          </Button>
          <span>{me?.display_name}</span>
          <Button size="small" onClick={() => void logout()}>
            退出
          </Button>
        </div>
      </header>
      <Layout.Content className="content">
        {view === "settings" ? <SettingsPage canWrite={Boolean(me?.perms.includes("create"))} /> : null}
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
