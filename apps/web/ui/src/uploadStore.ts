import { useEffect, useSyncExternalStore } from "react";
import {
  api,
  UploadPausedError,
  UPLOAD_TIMEOUT_MS,
  type PendingUploadReceipt,
  type UploadProgress,
  type UploadReceipt,
} from "./api";
import { UPLOAD_TOO_LARGE, bytesTooLarge } from "./uploadLimit";

export type UploadKind = "compare" | "mockup";
export type UploadField = "excel" | "pdf" | "ai";
export type UploadPhase = "draft" | "uploading" | "retrying" | "confirming" | "paused" | "ready" | "failed";

export type UploadFile = {
  field: UploadField;
  name: string;
  bytes: number;
  lastModified?: number;
  file?: File;
};

export type UploadSnapshot = {
  attempt: number;
  kind: UploadKind;
  phase: UploadPhase;
  files: UploadFile[];
  productName: string;
  packSurface: string;
  pct: number;
  loaded: number;
  total: number;
  receipt?: string;
  uploadId?: string;
  clientUploadId?: string;
  retryAttempt?: number;
  error?: string;
  createdAt: string;
};

export type UploadMeta = {
  productName?: string;
  packSurface?: string;
};

export type UploadTransport = (
  fd: FormData,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
) => Promise<UploadReceipt>;

export type UploadDiscard = (receipt: string) => Promise<unknown>;
export const UPLOAD_RECOVERY_INTERVAL_MS = 5000;

const FIELD_ORDER: Record<UploadKind, UploadField[]> = {
  compare: ["excel", "pdf"],
  mockup: ["ai"],
};

function orderedFiles(kind: UploadKind, files: UploadFile[]): UploadFile[] {
  const byField = new Map(files.map((file) => [file.field, file]));
  return FIELD_ORDER[kind].flatMap((field) => {
    const file = byField.get(field);
    return file ? [file] : [];
  });
}

function uploadForm(
  kind: UploadKind,
  files: UploadFile[],
  clientUploadId: string,
  meta: { productName: string; packSurface: string },
): FormData {
  const fd = new FormData();
  fd.append("client_upload_id", clientUploadId);
  fd.append("product_name", meta.productName);
  fd.append("pack_surface", meta.packSurface);
  for (const selected of files) {
    if (!selected.file) continue;
    fd.append(kind === "mockup" ? "file" : selected.field, selected.file);
  }
  return fd;
}

function newClientUploadId(attempt: number): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? uuid.replaceAll("-", "") : `upload_${Date.now().toString(36)}_${attempt}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return "上传失败，请重新上传。";
}

export function uploadPhaseLine(snapshot: UploadSnapshot, readyText: string): string {
  if (snapshot.phase === "confirming") return "文件已传完，服务器正在确认";
  if (snapshot.phase === "retrying") return `网络波动，正在第 ${snapshot.retryAttempt || 1} 次重新连接`;
  if (snapshot.phase === "uploading") return "正在上传到服务器";
  if (snapshot.phase === "paused") return snapshot.error || "上传已暂停，服务器已保存收到的部分";
  if (snapshot.phase === "ready") return readyText;
  if (snapshot.phase === "failed") return snapshot.error || "上传失败，请重新上传。";
  return "等待选齐文件";
}

export function uploadIsBusy(snapshot: UploadSnapshot | null): boolean {
  return snapshot?.phase === "uploading" || snapshot?.phase === "retrying" || snapshot?.phase === "confirming";
}

export function createUploadStore(
  transport: UploadTransport = api.stageUpload,
  discard: UploadDiscard = api.discardUpload,
) {
  let sequence = 0;
  let state: Record<UploadKind, UploadSnapshot | null> = { compare: null, mockup: null };
  const listeners = new Set<() => void>();
  const controllers: Partial<Record<UploadKind, AbortController>> = {};

  function publish(kind: UploadKind, next: UploadSnapshot | null) {
    state = { ...state, [kind]: next };
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function get(kind: UploadKind) {
    return state[kind];
  }

  function completeFiles(kind: UploadKind, files: UploadFile[]): boolean {
    const byField = new Map(files.map((file) => [file.field, file]));
    return FIELD_ORDER[kind].every((required) => byField.get(required)?.file instanceof File);
  }

  function sameBrowserFile(saved: UploadFile | undefined, file: File | null): boolean {
    if (!saved || !file) return false;
    return (
      saved.name === file.name &&
      saved.bytes === file.size &&
      (saved.lastModified === undefined || saved.lastModified === file.lastModified)
    );
  }

  function runUpload(kind: UploadKind, base: UploadSnapshot): UploadSnapshot {
    const attempt = base.attempt;
    const clientUploadId = base.clientUploadId || newClientUploadId(attempt);
    const controller = new AbortController();
    controllers[kind] = controller;
    const uploading: UploadSnapshot = {
      ...base,
      clientUploadId,
      phase: "uploading",
      error: undefined,
      retryAttempt: undefined,
    };
    publish(kind, uploading);

    void transport(
      uploadForm(kind, uploading.files, clientUploadId, {
        productName: uploading.productName,
        packSurface: uploading.packSurface,
      }),
      (progress) => {
        const latest = state[kind];
        if (!latest || latest.attempt !== attempt) return;
        const pct = Math.max(0, Math.min(100, Math.round(progress.pct)));
        const phase =
          progress.phase || (pct >= 100 ? "confirming" : "uploading");
        publish(kind, {
          ...latest,
          phase,
          pct,
          loaded: Math.max(0, progress.loaded),
          total: Math.max(progress.total, latest.total),
          uploadId: progress.uploadId || latest.uploadId,
          retryAttempt: progress.retryAttempt,
          error: undefined,
        });
      },
      controller.signal,
    )
      .then((receipt) => {
        const latest = state[kind];
        if (!latest || latest.attempt !== attempt) return;
        delete controllers[kind];
        const totalBytes = receipt.files.reduce((sum, selected) => sum + selected.bytes, 0) || latest.total;
        publish(kind, {
          ...latest,
          phase: "ready",
          pct: 100,
          loaded: totalBytes,
          total: totalBytes,
          receipt: receipt.receipt,
          uploadId: receipt.receipt,
          files: latest.files.map((selected) => {
            const saved = receipt.files.find((item) => item.field === selected.field);
            return {
              field: selected.field,
              name: saved?.name ?? selected.name,
              bytes: saved?.bytes ?? selected.bytes,
              lastModified: selected.lastModified,
            };
          }),
          retryAttempt: undefined,
          error: undefined,
        });
      })
      .catch((err: unknown) => {
        const latest = state[kind];
        if (!latest || latest.attempt !== attempt) return;
        delete controllers[kind];
        const paused = err instanceof UploadPausedError;
        publish(kind, {
          ...latest,
          phase: paused ? "paused" : "failed",
          error: errorMessage(err),
          receipt: undefined,
          uploadId: paused ? err.uploadId || latest.uploadId : latest.uploadId,
          retryAttempt: undefined,
        });
      });

    return uploading;
  }

  function updateMeta(kind: UploadKind, meta: UploadMeta) {
    const current = state[kind];
    if (!current) {
      const next: UploadSnapshot = {
        attempt: ++sequence,
        kind,
        phase: "draft",
        files: [],
        productName: meta.productName || "",
        packSurface: meta.packSurface || "carton",
        pct: 0,
        loaded: 0,
        total: 0,
        createdAt: new Date().toISOString(),
      };
      publish(kind, next);
      return next;
    }
    const next = {
      ...current,
      productName: meta.productName ?? current.productName,
      packSurface: meta.packSurface ?? current.packSurface,
    };
    publish(kind, next);
    return next;
  }

  function replaceFile(kind: UploadKind, field: UploadField, file: File | null, meta: UploadMeta = {}) {
    if (!FIELD_ORDER[kind].includes(field)) {
      throw new Error(`上传栏 ${field} 不属于 ${kind}`);
    }

    const current = state[kind];
    const attempt = ++sequence;
    controllers[kind]?.abort();
    delete controllers[kind];

    const savedField = current?.files.find((selected) => selected.field === field);
    const resuming = Boolean(current?.phase === "paused" && current.clientUploadId && sameBrowserFile(savedField, file));
    const oldServerId = current?.receipt || current?.uploadId;
    if (oldServerId && !resuming) void discard(oldServerId).catch(() => undefined);

    // ready 后原始 File 已主动释放；若只保留另一栏的文件名，会看起来像选齐了，
    // 实际却无法重传。此时更换任一栏就明确开始一组新稿，只保留新选择。
    const reusableFiles = current?.phase === "ready" || (current?.phase === "paused" && !resuming) ? [] : current?.files || [];
    const byField = new Map(reusableFiles.map((selected) => [selected.field, selected]));
    if (file) {
      byField.set(field, {
        field,
        name: file.name,
        bytes: file.size,
        lastModified: file.lastModified,
        file,
      });
    }
    else byField.delete(field);
    const files = orderedFiles(kind, [...byField.values()]);
    const total = files.reduce((sum, selected) => sum + selected.bytes, 0);
    const clientUploadId = resuming ? current?.clientUploadId : newClientUploadId(attempt);
    const base: UploadSnapshot = {
      attempt,
      kind,
      phase: "draft",
      files,
      productName: meta.productName ?? current?.productName ?? "",
      packSurface: meta.packSurface ?? current?.packSurface ?? "carton",
      pct: 0,
      loaded: 0,
      total,
      clientUploadId,
      uploadId: resuming ? current?.uploadId : undefined,
      createdAt: new Date().toISOString(),
    };

    if (bytesTooLarge(...files.map((selected) => selected.bytes))) {
      const failed = { ...base, phase: "failed" as const, error: UPLOAD_TOO_LARGE };
      publish(kind, failed);
      return failed;
    }

    if (!completeFiles(kind, files)) {
      const waiting = resuming
        ? { ...base, phase: "paused" as const, error: "服务器保留了已上传部分，请重新选择同一文件后继续" }
        : base;
      publish(kind, waiting);
      return waiting;
    }
    return runUpload(kind, base);
  }

  function retry(kind: UploadKind): UploadSnapshot | null {
    const current = state[kind];
    if (!current || !["paused", "failed"].includes(current.phase) || !completeFiles(kind, current.files)) return current;
    return runUpload(kind, { ...current, attempt: ++sequence, phase: "uploading", error: undefined });
  }

  function clear(kind: UploadKind, serverId?: string) {
    const current = state[kind];
    if (serverId && current?.receipt !== serverId && current?.uploadId !== serverId) return;
    controllers[kind]?.abort();
    delete controllers[kind];
    publish(kind, null);
  }

  async function abandon(kind: UploadKind): Promise<void> {
    const current = state[kind];
    controllers[kind]?.abort();
    delete controllers[kind];
    publish(kind, null);
    const serverId = current?.receipt || current?.uploadId;
    if (serverId) await discard(serverId);
  }

  function recover(kind: UploadKind, receipt: PendingUploadReceipt): boolean {
    const current = state[kind];
    if (
      !current?.clientUploadId ||
      receipt.kind !== kind ||
      receipt.client_upload_id !== current.clientUploadId
    ) {
      return false;
    }
    if (receipt.phase === "paused" && uploadIsBusy(current)) return true;
    controllers[kind]?.abort();
    delete controllers[kind];
    const attempt = ++sequence;
    publish(kind, {
      ...current,
      attempt,
      phase: receipt.phase,
      pct: receipt.bytes > 0 ? Math.round((receipt.received / receipt.bytes) * 100) : 0,
      loaded: receipt.received,
      total: receipt.bytes,
      receipt: receipt.phase === "ready" ? receipt.id : undefined,
      uploadId: receipt.id,
      files: current.files.map((selected) => {
        const saved = receipt.files.find((item) => item.field === selected.field);
        return {
          field: selected.field,
          name: saved?.name ?? selected.name,
          bytes: saved?.bytes ?? selected.bytes,
          lastModified: saved?.last_modified ?? selected.lastModified,
          ...(receipt.phase === "paused" && selected.file ? { file: selected.file } : {}),
        };
      }),
      error:
        receipt.phase === "paused"
          ? completeFiles(kind, current.files)
            ? "上传已暂停，服务器已保存收到的部分"
            : "上传已暂停，服务器已保存收到的部分；请重新选择同一文件继续"
          : undefined,
      createdAt: receipt.created_at,
    });
    return true;
  }

  function restore(kind: UploadKind, receipt: PendingUploadReceipt): boolean {
    if (receipt.kind !== kind) return false;
    controllers[kind]?.abort();
    delete controllers[kind];
    const total = receipt.bytes;
    publish(kind, {
      attempt: ++sequence,
      kind,
      phase: receipt.phase,
      files: receipt.files.map((file) => ({
        field: file.field as UploadField,
        name: file.name,
        bytes: file.bytes,
        lastModified: file.last_modified,
      })),
      productName: receipt.product_name || "",
      packSurface: receipt.pack_surface || "carton",
      pct: total > 0 ? Math.round((receipt.received / total) * 100) : 0,
      loaded: receipt.received,
      total,
      receipt: receipt.phase === "ready" ? receipt.id : undefined,
      uploadId: receipt.id,
      clientUploadId: receipt.client_upload_id,
      error: receipt.phase === "paused" ? "上传已暂停，服务器已保存收到的部分；请重新选择同一文件继续" : undefined,
      createdAt: receipt.created_at,
    });
    return true;
  }

  function abortAll() {
    for (const kind of Object.keys(controllers) as UploadKind[]) {
      controllers[kind]?.abort();
      delete controllers[kind];
    }
  }

  return { subscribe, get, updateMeta, replaceFile, retry, clear, abandon, recover, restore, abortAll };
}

export const uploadStore = createUploadStore();

export function useUploadSnapshot(kind: UploadKind): UploadSnapshot | null {
  return useSyncExternalStore(
    uploadStore.subscribe,
    () => uploadStore.get(kind),
    () => uploadStore.get(kind),
  );
}

/**
 * 上传响应可能在服务端落盘后丢失。新建页仍停留在前台时也主动回查本次
 * client_upload_id；列表页还有自己的回执列表同步，两条路径都只认本次上传。
 */
export function useUploadReceiptRecovery(
  kind: UploadKind,
  snapshot: UploadSnapshot | null,
  enabled = true,
): void {
  const clientUploadId = snapshot?.clientUploadId;
  const phase = snapshot?.phase;
  useEffect(() => {
    if (
      !enabled ||
      !clientUploadId ||
      !["confirming", "retrying", "paused", "failed"].includes(phase || "")
    ) {
      return;
    }
    let cancelled = false;
    const reconcile = () => {
      void api
        .uploads()
        .then((pending) => {
          if (cancelled) return;
          const receipt = pending.find((item) => {
            if (item.kind !== kind || item.client_upload_id !== clientUploadId) return false;
            return item.phase === "ready" || phase === "paused" || phase === "failed";
          });
          if (receipt) uploadStore.recover(kind, receipt);
        })
        .catch(() => undefined);
    };
    reconcile();
    const interval = window.setInterval(reconcile, UPLOAD_RECOVERY_INTERVAL_MS);
    const stop = window.setTimeout(() => window.clearInterval(interval), UPLOAD_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(stop);
    };
  }, [clientUploadId, enabled, kind, phase]);
}
