import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, REPO_ROOT } from "./config.js";

export const ILLUSTRATOR_AGENT_PROTOCOL = "beian.illustrator.v1";
export const ILLUSTRATOR_AGENT_PIPE = "beian-illustrator-v1";
export const ILLUSTRATOR_AGENT_STALE_MS = 15_000;
export const ILLUSTRATOR_AGENT_HEARTBEAT = join(DATA_DIR, "runtime", "illustrator-agent.json");
export const ILLUSTRATOR_AGENT_SCRIPT = join(REPO_ROOT, "scripts", "windows", "illustrator-agent.ps1");
export const ILLUSTRATOR_AGENT_SCRIPT_SHA256 = createHash("sha256")
  .update(readFileSync(ILLUSTRATOR_AGENT_SCRIPT))
  .digest("hex");
export const ILLUSTRATOR_AGENT_RELEASE_VERSION = readFileSync(join(REPO_ROOT, "VERSION"), "utf8").trim();

type Heartbeat = {
  protocol?: unknown;
  pid?: unknown;
  session_id?: unknown;
  user?: unknown;
  user_sid?: unknown;
  pipe?: unknown;
  state?: unknown;
  updated_at?: unknown;
  last_code?: unknown;
  script_sha256?: unknown;
  release_version?: unknown;
  build_identity?: unknown;
};

export type IllustratorAgentStatus = {
  required: boolean;
  ready: boolean;
  mode: "native" | "desktop_agent";
  state: string;
  message: string;
  session_id?: number;
  pid?: number;
  user?: string;
  user_sid?: string;
  pipe?: string;
  updated_at?: string;
  age_ms?: number;
  last_code?: string;
  script_sha256?: string;
  release_version?: string;
  build_identity?: string;
};

export function readIllustratorAgentStatus(options: {
  platform?: NodeJS.Platform;
  heartbeatPath?: string;
  nowMs?: number;
} = {}): IllustratorAgentStatus {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      required: false,
      ready: true,
      mode: "native",
      state: "not_required",
      message: "macOS 继续使用现有 AppleScript 桥",
    };
  }
  const heartbeatPath = options.heartbeatPath ?? ILLUSTRATOR_AGENT_HEARTBEAT;
  const offline = (state: string, message: string): IllustratorAgentStatus => ({
    required: true,
    ready: false,
    mode: "desktop_agent",
    state,
    message,
  });
  if (!existsSync(heartbeatPath)) {
    return offline("offline", "Illustrator 桌面代理未在线。请让管理员登录杭州电脑后重新打样。");
  }
  let heartbeat: Heartbeat;
  try {
    heartbeat = JSON.parse(readFileSync(heartbeatPath, "utf8")) as Heartbeat;
  } catch {
    return offline("invalid_heartbeat", "Illustrator 桌面代理状态损坏。请让管理员重新登录杭州电脑。");
  }
  if (heartbeat.protocol !== ILLUSTRATOR_AGENT_PROTOCOL) {
    return offline("protocol_mismatch", "Illustrator 桌面代理版本不匹配，请先完成杭州升版。");
  }
  const sessionId = Number(heartbeat.session_id);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return offline("wrong_session", "Illustrator 桌面代理没有运行在交互桌面，请让管理员重新登录杭州电脑。");
  }
  const pid = Number(heartbeat.pid);
  const pipe = String(heartbeat.pipe || "");
  const state = String(heartbeat.state || "");
  const userSid = String(heartbeat.user_sid || "");
  if (
    !Number.isInteger(pid)
    || pid <= 0
    || pipe !== ILLUSTRATOR_AGENT_PIPE
    || !["idle", "busy", "faulted"].includes(state)
    || !/^S-\d(?:-\d+)+$/i.test(userSid)
  ) {
    return offline("invalid_heartbeat", "Illustrator 桌面代理状态不完整。请让管理员重新登录杭州电脑。");
  }
  const scriptSha256 = String(heartbeat.script_sha256 || "").toLowerCase();
  const releaseVersion = String(heartbeat.release_version || "");
  if (
    scriptSha256 !== ILLUSTRATOR_AGENT_SCRIPT_SHA256
    || releaseVersion !== ILLUSTRATOR_AGENT_RELEASE_VERSION
  ) {
    return offline("build_mismatch", "Illustrator 桌面代理仍是旧版本，请先完成杭州升版。");
  }
  const updatedAt = String(heartbeat.updated_at || "");
  const updatedMs = Date.parse(updatedAt);
  const ageMs = (options.nowMs ?? Date.now()) - updatedMs;
  if (!Number.isFinite(updatedMs) || ageMs < -5_000 || ageMs > ILLUSTRATOR_AGENT_STALE_MS) {
    return offline("stale", "Illustrator 桌面代理已离线。请让管理员登录杭州电脑后重新打样。");
  }
  if (state === "faulted") {
    return {
      required: true,
      ready: false,
      mode: "desktop_agent",
      state,
      message: "Illustrator 桌面代理清理失败。请让管理员确认桌面稿件后重启代理。",
      session_id: sessionId,
      pid,
      user: String(heartbeat.user || "") || undefined,
      user_sid: userSid,
      pipe,
      updated_at: updatedAt,
      age_ms: Math.max(0, ageMs),
      last_code: String(heartbeat.last_code || "") || undefined,
      script_sha256: scriptSha256,
      release_version: releaseVersion,
      build_identity: String(heartbeat.build_identity || "") || undefined,
    };
  }
  return {
    required: true,
    ready: true,
    mode: "desktop_agent",
    state,
    message: "Illustrator 桌面代理在线；打样会在交互桌面按需启动 Illustrator。",
    session_id: sessionId,
    pid,
    user: String(heartbeat.user || "") || undefined,
    user_sid: userSid,
    pipe,
    updated_at: updatedAt,
    age_ms: Math.max(0, ageMs),
    last_code: String(heartbeat.last_code || "") || undefined,
    script_sha256: scriptSha256,
    release_version: releaseVersion,
    build_identity: String(heartbeat.build_identity || "") || undefined,
  };
}

export function publicIllustratorAgentStatus(status = readIllustratorAgentStatus()) {
  return {
    required: status.required,
    ready: status.ready,
    mode: status.mode,
    state: status.state,
    message: status.message,
    last_code: status.last_code,
  };
}

export function assertIllustratorAgentReady(status = readIllustratorAgentStatus()): IllustratorAgentStatus {
  if (!status.ready) {
    throw Object.assign(new Error(status.message), { status: 412, code: "illustrator_agent_offline" });
  }
  return status;
}
