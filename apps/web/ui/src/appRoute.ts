/** 浏览器地址。后退要能换台，不要整站钉在 /。 */

export type AppView = "tasks" | "new" | "review" | "mockup" | "history" | "settings";

export type AppRoute = {
  view: AppView;
  taskId?: string | null;
  mockupId?: string | null;
};

const TID = /^[0-9a-f]{12}$/i;

export function parsePath(pathname: string, search = "", hash = ""): AppRoute {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/new") return { view: "new" };
  if (p === "/history") return { view: "history" };
  if (p === "/settings") return { view: "settings" };
  const review = p.match(/^\/review\/([0-9a-f]{12})$/i);
  if (review) return { view: "review", taskId: review[1].toLowerCase() };
  if (p === "/review") return { view: "tasks" };
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
  if (route.view === "new") return "/new";
  if (route.view === "history") return "/history";
  if (route.view === "settings") return "/settings";
  if (route.view === "review") return route.taskId ? `/review/${route.taskId}` : "/review";
  if (route.view === "mockup") return route.mockupId ? `/mockup/${route.mockupId}` : "/mockup";
  return "/";
}

export function isSpaPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return true;
  return /^(?:\/new|\/history|\/settings|\/review(?:\/[0-9a-f]{12})?|\/mockup(?:\/[0-9a-f]{12})?)$/i.test(p);
}
