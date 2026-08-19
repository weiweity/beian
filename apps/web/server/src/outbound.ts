import https from "node:https";
import { URL } from "node:url";
import { trustPublicCas } from "./certs.js";

trustPublicCas();

/** 直连 HTTPS，不走 HTTP_PROXY。本机 Clash 会给 fetch 塞自签证书。 */
export function httpsJson(
  url: string,
  opts: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: "https:",
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: opts.method || "GET",
        headers: opts.headers,
        timeout: opts.timeoutMs ?? 12_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode || 0, json: text ? JSON.parse(text) : null });
          } catch {
            resolve({ status: res.statusCode || 0, json: { raw: text.slice(0, 240) } });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("连接飞书超时"));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
