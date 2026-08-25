/** 台地址出 HTML 还是去飞书。审稿台 `/reviewup` `/reviewup/new`，核对页 `/review/:id`，打样 `/mockup` `/mockup/new` `/mockup/:id`。旧 `/` `/new` `/review` 由 Hono 302。Vite :5173 仍走 SPA。 */

const SPA =
  /^(?:\/reviewup(?:\/new)?|\/new|\/history|\/settings|\/review(?:\/[0-9a-f]{12})?|\/mockup(?:\/(?:new|[0-9a-f]{12}))?)$/i;

export function isSpaPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return true;
  return SPA.test(p);
}

/** 旧书签：`/` `/new` `/review` → 审稿台新地址。有 query 时原样跟上（飞书 error 页）。 */
export function legacyDeskRedirect(pathname: string): string | null {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/" || p === "/review") return "/reviewup";
  if (p === "/new") return "/reviewup/new";
  return null;
}

export function spaIndexAction(input: {
  feishuError: string;
  hasSession: boolean;
  displayLogin: boolean;
  oauthReady: boolean;
}): "html" | "feishu" {
  if (input.feishuError) return "html";
  if (input.hasSession) return "html";
  if (input.displayLogin) return "html";
  if (input.oauthReady) return "feishu";
  return "html";
}
