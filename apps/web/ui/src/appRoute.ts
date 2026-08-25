/** 浏览器地址。审稿台 `/reviewup`，工作台 `/reviewup/new`。旧 `/` `/new` `/review` 仍能解析，写出时用新地址。 */

export type AppView = "tasks" | "new" | "review" | "mockup" | "mockupNew" | "history" | "settings";

export type AppRoute = {
  view: AppView;
  taskId?: string | null;
  mockupId?: string | null;
};

const TID = /^[0-9a-f]{12}$/i;
const SPA =
  /^(?:\/reviewup(?:\/new)?|\/new|\/history|\/settings|\/review(?:\/[0-9a-f]{12})?|\/mockup(?:\/(?:new|[0-9a-f]{12}))?)$/i;

export function parsePath(pathname: string, search = "", hash = ""): AppRoute {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/reviewup/new" || p === "/new") return { view: "new" };
  if (p === "/history") return { view: "history" };
  if (p === "/settings") return { view: "settings" };
  const review = p.match(/^\/review\/([0-9a-f]{12})$/i);
  if (review) return { view: "review", taskId: review[1].toLowerCase() };
  if (p === "/reviewup" || p === "/review") return { view: "tasks" };
  if (p === "/mockup/new") return { view: "mockupNew" };
  const mock = p.match(/^\/mockup\/([0-9a-f]{12})$/i);
  if (mock) return { view: "mockup", mockupId: mock[1].toLowerCase() };
  if (p === "/mockup") return { view: "mockup", mockupId: null };
  const q = new URLSearchParams(search);
  const qTask = q.get("task") || "";
  if (TID.test(qTask)) return { view: "review", taskId: qTask.toLowerCase() };
  const qMock = q.get("mockup") || "";
  if (TID.test(qMock)) return { view: "mockup", mockupId: qMock.toLowerCase() };
  if (q.get("tab") === "settings" || hash.replace(/^#/, "") === "settings") {
    return { view: "settings" };
  }
  return { view: "tasks" };
}

export function hrefOf(route: AppRoute): string {
  if (route.view === "new") return "/reviewup/new";
  if (route.view === "history") return "/history";
  if (route.view === "settings") return "/settings";
  if (route.view === "review") return route.taskId ? `/review/${route.taskId}` : "/reviewup";
  if (route.view === "mockupNew") return "/mockup/new";
  if (route.view === "mockup") return route.mockupId ? `/mockup/${route.mockupId}` : "/mockup";
  return "/reviewup";
}

export function isSpaPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return true;
  return SPA.test(p);
}
