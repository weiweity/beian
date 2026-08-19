import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { httpsJson } from "./outbound.js";
import { getSetting, saveSettings } from "./settings.js";

export type Role = "admin" | "reviewer" | "viewer";

const PERMS: Record<Role, string[]> = {
  admin: ["read", "create", "decide", "complete", "delete", "export", "backup", "archive", "ai_review", "manage_users"],
  reviewer: ["read", "create", "decide", "complete", "delete", "export", "archive", "ai_review"],
  viewer: ["read", "export"],
};

export type Session = {
  token: string;
  display_name: string;
  role: Role;
  open_id: string;
  source: string;
  created_at: number;
  expires_at: number;
};

const TTL = 7 * 24 * 3600;
const sessions = new Map<string, Session>();
const oauthStates = new Map<string, { exp: number; verifier: string }>();
let tenantCache: { key: string; exp: number } | null = null;

function sessionsPath() {
  return join(DATA_DIR, "sessions.json");
}

function usersPath() {
  return join(DATA_DIR, "users.json");
}

export function loadSessions(): void {
  sessions.clear();
  const p = sessionsPath();
  if (!existsSync(p)) return;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, Session>;
    const now = Date.now() / 1000;
    for (const [tok, s] of Object.entries(raw || {})) {
      if (Number(s.expires_at) > now) sessions.set(tok, s);
    }
  } catch {
    /* ignore corrupt */
  }
}

function saveSessions(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const obj: Record<string, Session> = {};
  for (const [k, v] of sessions) obj[k] = v;
  writeFileSync(sessionsPath(), JSON.stringify(obj, null, 2), { mode: 0o600 });
}

type User = { name?: string; role?: string; open_id?: string; note?: string };

function ensureUsersFile(): void {
  const p = usersPath();
  if (existsSync(p)) return;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    p,
    JSON.stringify(
      {
        users: [
          {
            name: "管理员",
            role: "admin",
            note: "本机首次启动自动创建。请改名并填写 open_id。",
          },
        ],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}

function users(): User[] {
  ensureUsersFile();
  const p = usersPath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { users?: User[] } | User[];
    return Array.isArray(raw) ? raw : raw.users || [];
  } catch {
    return [];
  }
}

function writeUsers(list: User[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(usersPath(), JSON.stringify({ users: list }, null, 2) + "\n", { mode: 0o600 });
}

function provisionUser(name: string, openId: string): User {
  const list = users();
  const row: User = {
    name: (name || "飞书用户").slice(0, 40),
    role: "reviewer",
    open_id: openId,
    note: "飞书首次进入",
  };
  list.push(row);
  writeUsers(list);
  return row;
}

function allowOpenIds(): Set<string> {
  return new Set(
    (getSetting("FEISHU_ALLOW_OPEN_IDS") || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("ou_")),
  );
}

function appId(): string {
  return getSetting("FEISHU_APP_ID").trim();
}

function appSecret(): string {
  return getSetting("FEISHU_APP_SECRET").trim();
}

export function issueSession(name: string, role: Role, openId = "", source = "feishu"): Session {
  const now = Date.now() / 1000;
  const sess: Session = {
    token: randomBytes(18).toString("base64url"),
    display_name: name.slice(0, 40),
    role,
    open_id: openId.slice(0, 64),
    source,
    created_at: now,
    expires_at: now + TTL,
  };
  sessions.set(sess.token, sess);
  saveSessions();
  return sess;
}

export function allowedTenantKey(): string {
  return getSetting("FEISHU_TENANT_KEY").trim();
}

/** 已配置 > 开放平台查到的 > 这次授权带回的。 */
export function pickAllowedTenant(configured: string, fromApi: string, fromUser: string): string {
  return configured.trim() || fromApi.trim() || fromUser.trim();
}

export function rememberTenantKey(key: string): void {
  const k = key.trim();
  if (!k || allowedTenantKey()) return;
  tenantCache = { key: k, exp: Date.now() + 3_600_000 };
  saveSettings({ FEISHU_TENANT_KEY: k });
}

export async function lockAllowedTenant(fromUser = ""): Promise<string> {
  const configured = allowedTenantKey();
  if (configured) return configured;
  const fromApi = await resolveAllowedTenantKey();
  const key = pickAllowedTenant(configured, fromApi, fromUser);
  if (key) rememberTenantKey(key);
  return key;
}

export function sessionFromFeishu(
  openId: string,
  feishuName: string,
  tenantKey = "",
  expectedTenant = "",
  opts: { provision?: boolean } = {},
): Session {
  const expected = expectedTenant || allowedTenantKey();
  if (expected && tenantKey && tenantKey !== expected) {
    throw Object.assign(new Error("只允许伸美公司的飞书号进入。"), { status: 403 });
  }
  if (!openId.startsWith("ou_")) throw Object.assign(new Error("飞书身份无效"), { status: 403 });
  let user = users().find((u) => (u.open_id || "").trim() === openId);
  const listed = Boolean(user) || allowOpenIds().has(openId);
  const tenantOk = !expected || !tenantKey || tenantKey === expected;
  if (!user && !listed && opts.provision && tenantOk) {
    user = provisionUser((feishuName || "").trim(), openId);
  }
  if (!user && !listed) {
    throw Object.assign(
      new Error(`这个飞书号不在白名单（open_id=${openId}）。`),
      { status: 403 },
    );
  }
  const name = String(user?.name || feishuName || "飞书用户").slice(0, 40);
  const role = ((user?.role || "reviewer") as Role) in PERMS ? ((user?.role || "reviewer") as Role) : "reviewer";
  return issueSession(name, role, openId, "feishu");
}

export function getSession(token: string | undefined | null): Session | null {
  if (!token) return null;
  const t = token.toLowerCase().startsWith("bearer ") ? token.slice(7).trim() : token.trim();
  const s = sessions.get(t);
  if (!s) return null;
  if (s.expires_at < Date.now() / 1000) {
    sessions.delete(t);
    return null;
  }
  return s;
}

export function logout(token: string | undefined | null): void {
  const s = getSession(token);
  if (s) {
    sessions.delete(s.token);
    saveSessions();
  }
}

export function hasPerm(role: Role, perm: string): boolean {
  return PERMS[role]?.includes(perm) ?? false;
}

export function isLoopbackHost(hostHeader: string): boolean {
  const host = (hostHeader || "").split(":")[0].replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** 飞书客户端 UA，或本机回环。公网普通浏览器不能发起授权。 */
export function requestLooksLikeFeishu(userAgent: string, hostHeader: string): boolean {
  if (/Lark|Feishu/i.test(userAgent || "")) return true;
  return isLoopbackHost(hostHeader);
}

export function displayLoginAllowed(hostHeader = ""): boolean {
  if (/^(1|true|yes)$/i.test(getSetting("WB_PUBLIC"))) return false;
  if (hostHeader && !isLoopbackHost(hostHeader)) return false;
  return !/^(0|false|no)$/i.test(getSetting("WB_DEV_DISPLAY_LOGIN") || "true");
}

export function createDisplaySession(name: string, hostHeader = ""): Session {
  if (!displayLoginAllowed(hostHeader)) {
    throw Object.assign(new Error("显示名登录已关闭。公网请用飞书身份。"), { status: 410 });
  }
  const n = name.trim();
  if (!n || n.length > 40) throw Object.assign(new Error("显示名 1–40 字"), { status: 400 });
  const user = users().find((u) => (u.name || "").trim() === n);
  if (!user) throw Object.assign(new Error("未知用户"), { status: 403 });
  const role = ((user.role || "reviewer") as Role) in PERMS ? ((user.role || "reviewer") as Role) : "reviewer";
  return issueSession(n, role, "", "display");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function beginOAuth(): { state: string; challenge: string } {
  const state = randomBytes(18).toString("base64url");
  const { verifier, challenge } = pkcePair();
  oauthStates.set(state, { exp: Date.now() + 600_000, verifier });
  return { state, challenge };
}

/** 用过即删。过期或不存在返回 null。 */
export function consumeOAuthState(state: string): string | null {
  const row = oauthStates.get(state);
  oauthStates.delete(state);
  if (!row || row.exp < Date.now()) return null;
  return row.verifier;
}

export function oauthReady(): boolean {
  return Boolean(appId() && appSecret());
}

export function authorizeUrl(redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: appId(),
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${q.toString()}`;
}

export function describeOutboundError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const cause = `${e.cause?.code || ""} ${e.cause?.message || ""}`;
  const msg = e instanceof Error ? e.message : String(err);
  if (/SELF_SIGNED|self-signed|UNABLE_TO_VERIFY/i.test(`${msg} ${cause}`)) {
    return "连不上飞书：本机代理证书不被信任。审稿台已改为直连开放平台，请再试一次。";
  }
  if (msg === "fetch failed" || /fetch failed/i.test(msg)) {
    return "连不上飞书开放平台，请再试一次。";
  }
  return msg;
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<{ open_id: string; name: string; tenant_key: string }> {
  let tokenJson: { access_token?: string; code?: number; msg?: string };
  try {
    const tokenRes = await httpsJson("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: appId(),
        client_secret: appSecret(),
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    tokenJson = (tokenRes.json || {}) as { access_token?: string; code?: number; msg?: string };
  } catch (err) {
    throw new Error(describeOutboundError(err));
  }
  if (!tokenJson.access_token) {
    throw new Error(tokenJson.msg || "飞书换票失败");
  }
  let userJson: {
    data?: { open_id?: string; name?: string; tenant_key?: string };
    msg?: string;
  };
  try {
    const userRes = await httpsJson("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    userJson = (userRes.json || {}) as {
      data?: { open_id?: string; name?: string; tenant_key?: string };
      msg?: string;
    };
  } catch (err) {
    throw new Error(describeOutboundError(err));
  }
  const openId = userJson.data?.open_id || "";
  const name = userJson.data?.name || "";
  const tenantKey = userJson.data?.tenant_key || "";
  if (!openId) throw new Error(userJson.msg || "飞书未返回 open_id");
  return { open_id: openId, name, tenant_key: tenantKey };
}

/**
 * 本应用所在飞书企业。设置了 FEISHU_TENANT_KEY 则用设置。
 * 未开通 tenant:tenant:readonly 时查不到，返回空；调用方应回退到授权带回的 tenant_key。
 */
export async function resolveAllowedTenantKey(): Promise<string> {
  const configured = allowedTenantKey();
  if (configured) return configured;
  if (tenantCache && tenantCache.exp > Date.now()) return tenantCache.key;
  if (!oauthReady()) return "";
  try {
    const tokenRes = await httpsJson("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId(), app_secret: appSecret() }),
    });
    const tokenJson = (tokenRes.json || {}) as { tenant_access_token?: string; code?: number };
    if (!tokenJson.tenant_access_token) return "";
    const q = await httpsJson("https://open.feishu.cn/open-apis/tenant/v2/tenant/query", {
      headers: { Authorization: `Bearer ${tokenJson.tenant_access_token}` },
    });
    const body = (q.json || {}) as { data?: { tenant?: { tenant_key?: string } }; code?: number };
    const key = body.data?.tenant?.tenant_key || "";
    if (key) tenantCache = { key, exp: Date.now() + 3_600_000 };
    return key;
  } catch {
    return "";
  }
}

/** 防测试里误用常量比较 cookie。 */
export function signHint(token: string): string {
  return createHmac("sha256", "beian-session").update(token).digest("hex").slice(0, 8);
}

export function sameToken(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

loadSessions();
