import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const RELEASE_CONTROL_PROTOCOL = "beian.release.v1";
export const RELEASE_DRAIN_MESSAGE = "系统正在安全升版，暂不接收业务写入，请稍后重试";
export const RELEASE_DRAIN_LEASE_MS = 120_000;
/** 仅供 VITEST 进程验证 HTTP 合同；生产进程始终生成随机 token。 */
export const RELEASE_CONTROL_TEST_TOKEN = "beian-release-control-test-token-v1";

export type ReleaseAdmissionSnapshot = {
  state: "open" | "draining";
  active: number;
  entered_at?: string;
  lease_id?: string;
  mode?: "lease" | "transaction";
  expires_at?: string;
};

export type ReleaseReadiness = {
  ready: boolean;
  blocker_codes: string[];
};

type ReleaseReadinessInput = {
  admission: ReleaseAdmissionSnapshot;
  jobs: Array<{ running: number; queued: number }>;
  jobsUnknown?: number;
  uploads: { active: number; waiting: number };
  notifications: { active: number };
  illustratorState?: string;
};

/**
 * 把队列、上传和桌面代理的隐藏知识收在服务端；部署脚本只消费稳定的
 * ready/blocker_codes 合同，不理解作业种类、磁盘目录或心跳格式。
 */
export function releaseReadiness(input: ReleaseReadinessInput): ReleaseReadiness {
  const blockers: string[] = [];
  if (input.admission.state !== "draining") blockers.push("not_draining");
  if (input.admission.active > 0) blockers.push("requests_active");
  if (input.jobs.some((slot) => slot.running > 0 || slot.queued > 0)) blockers.push("jobs_active");
  if ((input.jobsUnknown || 0) > 0) blockers.push("jobs_unknown");
  if (input.uploads.active > 0 || input.uploads.waiting > 0) blockers.push("uploads_active");
  if (input.notifications.active > 0) blockers.push("notifications_active");
  if (input.illustratorState === "busy" || input.illustratorState === "faulted") {
    blockers.push("illustrator_agent_blocked");
  }
  return { ready: blockers.length === 0, blocker_codes: blockers };
}

/**
 * Hono middleware completes before Node has necessarily drained a Response body.
 * Keep the admission token until the protected stream closes, errors, or is
 * cancelled so Stop-Service cannot truncate a GLB/PPT/PNG already in flight.
 */
export function holdReleaseUntilResponseSettles(response: Response, release: () => void): Response {
  const body = response.body;
  if (!body) {
    release();
    return response;
  }
  const reader = body.getReader();
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    release();
  };
  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          settle();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (err) {
        settle();
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
  return new Response(guarded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * 发版排空默认覆盖所有动态页面和业务 API，包括会写 session/OAuth 状态的 GET。
 * 仅不可变静态资源、健康探针和受 token 保护的 release control 不入闸；这样
 * 新路由默认安全，且不要求 release.ps1 理解产品内部副作用。
 */
export function isReleaseProtectedRequest(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (path === "/api/internal/release/drain") return false;
  if (path === "/api/internal/release/identity") return false;
  if (path === "/api/health" && ["GET", "HEAD"].includes(normalizedMethod)) return false;
  if (["GET", "HEAD"].includes(normalizedMethod)) {
    if (path === "/favicon.ico") return false;
    if (path.startsWith("/brand/")) return false;
    if (path.startsWith("/assets/")) return false;
  }
  return true;
}

function tokenMatches(expected: string, candidate: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(candidate, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * admission gate：enter 与 acquire 在 Node 事件循环里同步完成，避免“检查为空后又
 * 接进一单”。排空先用短租约，恢复日志落盘后提升为不自动过期的事务 fence；新 Node
 * 代际继承同一 fence，直到同一事务显式放行。
 */
export function createReleaseAdmission(
  token = randomBytes(32).toString("base64url"),
  options: { leaseMs?: number; now?: () => number; fencePath?: string; instanceId?: string } = {},
) {
  if (token.length < 32) throw new Error("release control token is too short");
  const instanceId = options.instanceId ?? randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(instanceId)) {
    throw new Error("release control instance id is invalid");
  }
  const leaseMs = options.leaseMs ?? RELEASE_DRAIN_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs < 1_000) throw new Error("release drain lease is too short");
  const now = options.now ?? Date.now;
  let draining = false;
  let active = 0;
  let enteredAt = "";
  let leaseId = "";
  let drainMode: "lease" | "transaction" = "lease";
  let expiresAtMs = 0;
  const fencePath = options.fencePath;

  const removeFence = (): void => {
    if (fencePath) rmSync(fencePath, { force: true });
  };

  const persistFence = (): void => {
    if (!fencePath || !draining) return;
    mkdirSync(dirname(fencePath), { recursive: true });
    const tempPath = `${fencePath}.${process.pid}.tmp`;
    try {
      const payload: Record<string, unknown> = {
        protocol: RELEASE_CONTROL_PROTOCOL,
        lease_id: leaseId,
        mode: drainMode,
        entered_at: enteredAt,
      };
      if (drainMode === "lease") payload.expires_at = new Date(expiresAtMs).toISOString();
      writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, fencePath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  };

  const clearDrain = (): void => {
    removeFence();
    draining = false;
    enteredAt = "";
    leaseId = "";
    drainMode = "lease";
    expiresAtMs = 0;
  };

  const expireLease = (): void => {
    if (draining && drainMode === "lease" && now() >= expiresAtMs) clearDrain();
  };

  const assertLeaseId = (candidate: string): void => {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(candidate)) {
      throw Object.assign(new Error("release lease id is invalid"), { status: 400 });
    }
  };

  const assertCurrentLease = (candidate: string): void => {
    assertLeaseId(candidate);
    expireLease();
    if (!draining || candidate !== leaseId) {
      throw Object.assign(new Error("release lease is not current"), { status: 409 });
    }
  };

  const renewLease = (): void => {
    if (drainMode === "lease") expiresAtMs = now() + leaseMs;
    persistFence();
  };

  if (fencePath && existsSync(fencePath)) {
    const raw = JSON.parse(readFileSync(fencePath, "utf8")) as Record<string, unknown>;
    const restoredLeaseId = String(raw.lease_id || "");
    const restoredEnteredAt = String(raw.entered_at || "");
    const restoredMode = raw.mode === "transaction" ? "transaction" : "lease";
    const restoredExpiresAt = Date.parse(String(raw.expires_at || ""));
    if (
      raw.protocol !== RELEASE_CONTROL_PROTOCOL
      || !/^[A-Za-z0-9_-]{16,128}$/.test(restoredLeaseId)
      || !Number.isFinite(Date.parse(restoredEnteredAt))
      || (restoredMode === "lease" && !Number.isFinite(restoredExpiresAt))
    ) {
      throw new Error("release drain fence is invalid");
    }
    if (restoredMode === "lease" && restoredExpiresAt <= now()) {
      removeFence();
    } else {
      draining = true;
      leaseId = restoredLeaseId;
      enteredAt = restoredEnteredAt;
      drainMode = restoredMode;
      expiresAtMs = restoredMode === "lease" ? restoredExpiresAt : 0;
    }
  }

  const snapshot = (): ReleaseAdmissionSnapshot => {
    expireLease();
    return {
      state: draining ? "draining" : "open",
      active,
      ...(enteredAt ? { entered_at: enteredAt } : {}),
      ...(leaseId ? {
        lease_id: leaseId,
        mode: drainMode,
        ...(drainMode === "lease" ? { expires_at: new Date(expiresAtMs).toISOString() } : {}),
      } : {}),
    };
  };

  const authorize = (candidate: string): void => {
    if (!tokenMatches(token, candidate)) {
      throw Object.assign(new Error("release control denied"), { status: 403 });
    }
  };

  return {
    instanceId,
    acquire(): (() => void) | null {
      expireLease();
      if (draining) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      };
    },
    enter(candidate: string, requestedLeaseId: string): ReleaseAdmissionSnapshot {
      authorize(candidate);
      assertLeaseId(requestedLeaseId);
      expireLease();
      if (draining && requestedLeaseId !== leaseId) {
        throw Object.assign(new Error("release drain already has another lease"), { status: 409 });
      }
      if (!draining) {
        draining = true;
        enteredAt = new Date(now()).toISOString();
        leaseId = requestedLeaseId;
        drainMode = "lease";
      }
      renewLease();
      return snapshot();
    },
    promote(candidate: string, requestedLeaseId: string): ReleaseAdmissionSnapshot {
      authorize(candidate);
      assertCurrentLease(requestedLeaseId);
      drainMode = "transaction";
      expiresAtMs = 0;
      persistFence();
      return snapshot();
    },
    leave(candidate: string, requestedLeaseId: string): ReleaseAdmissionSnapshot {
      authorize(candidate);
      expireLease();
      if (!draining) return snapshot();
      assertCurrentLease(requestedLeaseId);
      clearDrain();
      return snapshot();
    },
    inspect(candidate: string, requestedLeaseId: string): ReleaseAdmissionSnapshot {
      authorize(candidate);
      assertCurrentLease(requestedLeaseId);
      renewLease();
      return snapshot();
    },
    snapshot,
    identity(candidate: string): string {
      authorize(candidate);
      return instanceId;
    },
    controlFile(path: string, version: string, pid = process.pid): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({
        protocol: RELEASE_CONTROL_PROTOCOL,
        token,
        instance_id: instanceId,
        pid,
        version,
        written_at: new Date().toISOString(),
      })}\n`, { encoding: "utf8", mode: 0o600 });
    },
  };
}
