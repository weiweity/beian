import { useEffect, useSyncExternalStore } from "react";
import {
  api,
  UPLOAD_TIMEOUT_MS,
  type PendingUploadReceipt,
  type UploadProgress,
  type UploadReceipt,
} from "./api";
import { UPLOAD_TOO_LARGE, bytesTooLarge } from "./uploadLimit";

export type UploadKind = "compare" | "mockup";
export type UploadField = "excel" | "pdf" | "ai";
export type UploadPhase = "draft" | "uploading" | "confirming" | "ready" | "failed";

export type UploadFile = {
  field: UploadField;
  name: string;
  bytes: number;
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
  clientUploadId?: string;
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

function uploadForm(kind: UploadKind, files: UploadFile[], clientUploadId: string): FormData {
  const fd = new FormData();
  fd.append("client_upload_id", clientUploadId);
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
  if (snapshot.phase === "confirming") return "服务器确认中";
  if (snapshot.phase === "uploading") return "正在上传";
  if (snapshot.phase === "ready") return readyText;
  if (snapshot.phase === "failed") return snapshot.error || "上传失败，请重新上传。";
  return "等待选齐文件";
}

export function uploadIsBusy(snapshot: UploadSnapshot | null): boolean {
  return snapshot?.phase === "uploading" || snapshot?.phase === "confirming";
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
    if (current?.receipt) void discard(current.receipt).catch(() => undefined);

    // ready 后原始 File 已主动释放；若只保留另一栏的文件名，会看起来像选齐了，
    // 实际却无法重传。此时更换任一栏就明确开始一组新稿，只保留新选择。
    const reusableFiles = current?.phase === "ready" ? [] : current?.files || [];
    const byField = new Map(reusableFiles.map((selected) => [selected.field, selected]));
    if (file) byField.set(field, { field, name: file.name, bytes: file.size, file });
    else byField.delete(field);
    const files = orderedFiles(kind, [...byField.values()]);
    const total = files.reduce((sum, selected) => sum + selected.bytes, 0);
    const clientUploadId = newClientUploadId(attempt);
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
      createdAt: new Date().toISOString(),
    };

    if (bytesTooLarge(...files.map((selected) => selected.bytes))) {
      const failed = { ...base, phase: "failed" as const, error: UPLOAD_TOO_LARGE };
      publish(kind, failed);
      return failed;
    }

    const complete = FIELD_ORDER[kind].every((required) => byField.get(required)?.file instanceof File);
    if (!complete) {
      publish(kind, base);
      return base;
    }

    const controller = new AbortController();
    controllers[kind] = controller;
    const uploading = { ...base, phase: "uploading" as const };
    publish(kind, uploading);

    void transport(
      uploadForm(kind, files, clientUploadId),
      (progress) => {
        const latest = state[kind];
        if (!latest || latest.attempt !== attempt) return;
        const pct = Math.max(0, Math.min(100, Math.round(progress.pct)));
        publish(kind, {
          ...latest,
          phase: pct >= 100 ? "confirming" : "uploading",
          pct,
          loaded: Math.max(0, progress.loaded),
          total: Math.max(progress.total, latest.total),
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
          files: latest.files.map((selected) => {
            const saved = receipt.files.find((item) => item.field === selected.field);
            // 回执已经落盘后，开工只需要 receipt。及时丢掉原始 File，避免待开工时
            // 浏览器继续占着整份稿件内存；文件名和字节数仍用于页面恢复展示。
            return {
              field: selected.field,
              name: saved?.name ?? selected.name,
              bytes: saved?.bytes ?? selected.bytes,
            };
          }),
          error: undefined,
        });
      })
      .catch((err: unknown) => {
        const latest = state[kind];
        if (!latest || latest.attempt !== attempt) return;
        delete controllers[kind];
        publish(kind, { ...latest, phase: "failed", error: errorMessage(err), receipt: undefined });
      });

    return uploading;
  }

  function clear(kind: UploadKind, receipt?: string) {
    const current = state[kind];
    if (receipt && current?.receipt !== receipt) return;
    controllers[kind]?.abort();
    delete controllers[kind];
    publish(kind, null);
  }

  async function abandon(kind: UploadKind): Promise<void> {
    const current = state[kind];
    controllers[kind]?.abort();
    delete controllers[kind];
    publish(kind, null);
    if (current?.receipt) await discard(current.receipt);
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
    controllers[kind]?.abort();
    delete controllers[kind];
    const attempt = ++sequence;
    publish(kind, {
      ...current,
      attempt,
      phase: "ready",
      pct: 100,
      loaded: receipt.bytes,
      total: receipt.bytes,
      receipt: receipt.id,
      files: current.files.map((selected) => {
        const saved = receipt.files.find((item) => item.field === selected.field);
        return {
          field: selected.field,
          name: saved?.name ?? selected.name,
          bytes: saved?.bytes ?? selected.bytes,
        };
      }),
      error: undefined,
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

  return { subscribe, get, updateMeta, replaceFile, clear, abandon, recover, abortAll };
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
      (phase !== "confirming" && phase !== "failed")
    ) {
      return;
    }
    let cancelled = false;
    const reconcile = () => {
      void api
        .uploads()
        .then((pending) => {
          if (cancelled) return;
          const receipt = pending.find(
            (item) => item.kind === kind && item.client_upload_id === clientUploadId,
          );
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
