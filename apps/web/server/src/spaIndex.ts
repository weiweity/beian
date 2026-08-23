/** GET / 是出 HTML 还是直接去飞书。Vite :5173 仍走 SPA，不经过这里。 */

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
