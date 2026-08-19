import { createHmac } from "node:crypto";

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(path: string): string {
  const raw = path.startsWith("/") ? path : `/${path}`;
  return raw
    .split("/")
    .map((seg) => rfc3986(seg))
    .join("/");
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k] ?? "")}`)
    .join("&");
}

export function bceAuthorization(opts: {
  ak: string;
  sk: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  now?: Date;
  expireSec?: number;
}): string {
  const ts = (opts.now || new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const expire = opts.expireSec ?? 1800;
  const prefix = `bce-auth-v1/${opts.ak}/${ts}/${expire}`;
  const headerMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers)) {
    headerMap[k.toLowerCase()] = String(v).trim();
  }
  const signed = Object.keys(headerMap)
    .filter(
      (k) =>
        k === "host" ||
        k === "content-type" ||
        k === "content-length" ||
        k === "content-md5" ||
        k.startsWith("x-bce-"),
    )
    .sort();
  const canonicalHeaders = signed.map((k) => `${rfc3986(k)}:${rfc3986(headerMap[k])}`).join("\n");
  const canonicalRequest = [
    opts.method.toUpperCase(),
    canonicalUri(opts.path),
    canonicalQuery(opts.query || {}),
    canonicalHeaders,
  ].join("\n");
  const signingKey = createHmac("sha256", opts.sk).update(prefix).digest("hex");
  const signature = createHmac("sha256", signingKey).update(canonicalRequest).digest("hex");
  return `${prefix}/${signed.join(";")}/${signature}`;
}

export async function bceJson<T>(opts: {
  ak: string;
  sk: string;
  method: "GET" | "POST";
  host: string;
  path: string;
  query?: Record<string, string>;
  body?: string;
}): Promise<{ ok: boolean; status: number; data: T | null; error: string }> {
  const headers: Record<string, string> = {
    host: opts.host,
    "content-type": "application/json; charset=utf-8",
  };
  const auth = bceAuthorization({
    ak: opts.ak,
    sk: opts.sk,
    method: opts.method,
    path: opts.path,
    query: opts.query,
    headers,
  });
  const qs = opts.query
    ? "?" +
      Object.entries(opts.query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&")
    : "";
  try {
    const res = await fetch(`https://${opts.host}${opts.path}${qs}`, {
      method: opts.method,
      headers: {
        Host: opts.host,
        "Content-Type": headers["content-type"],
        Authorization: auth,
      },
      body: opts.method === "POST" ? opts.body || "{}" : undefined,
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg =
        data && typeof data === "object" && data && "message" in data
          ? String((data as { message?: string }).message)
          : text.slice(0, 180) || `HTTP ${res.status}`;
      return { ok: false, status: res.status, data, error: msg };
    }
    return { ok: true, status: res.status, data, error: "" };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : "连不上百度账单" };
  }
}
