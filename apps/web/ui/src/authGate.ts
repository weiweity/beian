/** 开发机 Vite 把 /api 当成 SPA 时，不能再跳回 /api/auth/feishu/login，否则会闪。 */
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

export function authFailureAction(input: {
  authError: string | null;
  apiBroken: string | null;
}): { href: string; label: string } {
  if (input.apiBroken && !input.authError) {
    return { href: "http://127.0.0.1:8787/", label: "打开本机审稿服务" };
  }
  return { href: "/api/auth/feishu/login", label: "重新飞书授权" };
}

export function describeBrokenApi(status: number, contentType: string): string | null {
  const ct = contentType.toLowerCase();
  if (status === 404 || ct.includes("text/html") || ct === "") {
    return "本机开发页没有把 /api 转到审稿服务（:8787）。请打开 http://127.0.0.1:8787/，或重启 npm run dev:ui。";
  }
  return null;
}
