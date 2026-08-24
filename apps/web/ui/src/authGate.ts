/** 开发机 Vite 把 /api 当成 SPA 时，不能再跳回 /api/auth/feishu/login，否则会闪。 */
import { isSpaPath } from "./appRoute";

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
}): { href: string; label: string } {
  if (input.apiBroken && !input.authError) {
    return { href: "http://127.0.0.1:8787/", label: "打开本机审稿服务" };
  }
  return { href: feishuLoginHref(input.pathname || "/"), label: "重新飞书授权" };
}

export function describeBrokenApi(_status: number, contentType: string): string | null {
  const ct = contentType.toLowerCase();
  if (ct.includes("application/json")) return null;
  if (ct.includes("text/html") || ct === "") {
    return "本机开发页没有把 /api 转到审稿服务（:8787）。请打开 http://127.0.0.1:8787/，或重启 npm run dev:ui。";
  }
  return null;
}
