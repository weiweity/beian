/** 开发机 Vite 把 /api 当成 SPA 时，不能再跳回 /api/auth/feishu/login，否则会闪。 */
import { isSpaPath } from "./appRoute";
import { API_DOWN_LOCAL, API_DOWN_PUBLIC } from "./apiHint";

export function shouldAutoRedirectToFeishu(input: {
  pathname: string;
  loggedIn: boolean;
  authError: string | null;
  apiBroken: string | null;
}): boolean {
  if (input.loggedIn) return false;
  if (input.authError) return false;
  if (input.apiBroken) return false;
  if (input.pathname.startsWith("/api/")) return false;
  return true;
}

export function feishuLoginHref(pathname = "/"): string {
  const p = (pathname || "/").replace(/\/+$/, "") || "/";
  if (!p.startsWith("/") || p.startsWith("//") || p === "/" || !isSpaPath(p)) {
    return "/api/auth/feishu/login";
  }
  return `/api/auth/feishu/login?next=${encodeURIComponent(p)}`;
}

export function authFailureAction(input: {
  authError: string | null;
  apiBroken: string | null;
  pathname?: string;
  host?: string;
}): { href: string; label: string } {
  if (input.apiBroken && !input.authError) {
    if (isLocalDevHost(input.host || "")) {
      return { href: "http://127.0.0.1:8787/", label: "打开本机审稿服务" };
    }
    const p = input.pathname || "/";
    return { href: isSpaPath(p) ? p : "/", label: "刷新后再试" };
  }
  return { href: feishuLoginHref(input.pathname || "/"), label: "重新飞书授权" };
}

function hostNameAndPort(host: string): { name: string; port: string } {
  const h = host.toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    const name = end >= 0 ? h.slice(1, end) : h;
    const port = end >= 0 && h[end + 1] === ":" ? h.slice(end + 2) : "";
    return { name, port };
  }
  const i = h.lastIndexOf(":");
  if (i < 0) return { name: h, port: "" };
  return { name: h.slice(0, i), port: h.slice(i + 1) };
}

export function isLocalDevHost(host: string): boolean {
  const h = (host || "").toLowerCase();
  if (!h) return true;
  const { name, port } = hostNameAndPort(h);
  if (name === "localhost" || name === "127.0.0.1" || name === "::1") return true;
  return port === "5173";
}

/** HTML / empty body from /api: Vite 没转到 :8787，或公网没回 JSON。JSON 404 / 413 不当这个。 */
export function describeBrokenApi(_status: number, contentType: string, host = ""): string | null {
  if (_status === 413) return null;
  const ct = contentType.toLowerCase();
  if (ct.includes("application/json")) return null;
  if (!(ct.includes("text/html") || ct === "")) return null;
  if (isLocalDevHost(host)) {
    return API_DOWN_LOCAL;
  }
  return API_DOWN_PUBLIC;
}
