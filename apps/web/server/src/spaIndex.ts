/** 台地址出 HTML 还是去飞书。覆盖 / /new /review/:id /mockup/:id /history /settings。Vite :5173 仍走 SPA。 */

export function isSpaPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return true;
  return /^(?:\/new|\/history|\/settings|\/review(?:\/[0-9a-f]{12})?|\/mockup(?:\/[0-9a-f]{12})?)$/i.test(p);
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
