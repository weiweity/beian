import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { getSetting } from "./settings.js";

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
const oauthStates = new Map<string, number>();

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

export function sessionFromFeishu(openId: string, feishuName: string): Session {
  if (!openId.startsWith("ou_")) throw Object.assign(new Error("飞书身份无效"), { status: 403 });
  const user = users().find((u) => (u.open_id || "").trim() === openId);
  const allowed = Boolean(user) || allowOpenIds().has(openId);
  if (!allowed) {
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

export function displayLoginAllowed(): boolean {
  if (/^(1|true|yes)$/i.test(getSetting("WB_PUBLIC"))) return false;
  return !/^(0|false|no)$/i.test(getSetting("WB_DEV_DISPLAY_LOGIN") || "true");
}

export function createDisplaySession(name: string): Session {
  if (!displayLoginAllowed()) {
    throw Object.assign(new Error("显示名登录已关闭。公网请用飞书身份。"), { status: 410 });
  }
  const n = name.trim();
  if (!n || n.length > 40) throw Object.assign(new Error("显示名 1–40 字"), { status: 400 });
  const user = users().find((u) => (u.name || "").trim() === n);
  if (!user) throw Object.assign(new Error("未知用户"), { status: 403 });
  const role = ((user.role || "reviewer") as Role) in PERMS ? ((user.role || "reviewer") as Role) : "reviewer";
  return issueSession(n, role, "", "display");
}

export function newOAuthState(): string {
  const token = randomBytes(18).toString("base64url");
  oauthStates.set(token, Date.now() + 600_000);
  return token;
}

export function consumeOAuthState(state: string): boolean {
  const exp = oauthStates.get(state);
  oauthStates.delete(state);
  return Boolean(exp && exp >= Date.now());
}

export function oauthReady(): boolean {
  return Boolean(appId() && appSecret());
}

export function authorizeUrl(redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: appId(),
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    scope: "contact:user.base:readonly",
  });
  return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${q.toString()}`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<{ open_id: string; name: string }> {
  const tokenRes = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: appId(),
      client_secret: appSecret(),
      code,
      redirect_uri: redirectUri,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; code?: number; msg?: string };
  if (!tokenJson.access_token) {
    throw new Error(tokenJson.msg || "飞书换票失败");
  }
  const userRes = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const userJson = (await userRes.json()) as {
    data?: { open_id?: string; name?: string };
    msg?: string;
  };
  const openId = userJson.data?.open_id || "";
  const name = userJson.data?.name || "";
  if (!openId) throw new Error(userJson.msg || "飞书未返回 open_id");
  return { open_id: openId, name };
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
