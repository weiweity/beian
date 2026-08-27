import type { PendingUploadReceipt } from "../api";
import type { UploadKind, UploadPhase, UploadSnapshot } from "../uploadStore";
import type { DeskCardRow } from "./deskBoard";
import { stemFromFilename } from "./stemName";

export type PendingUploadItem = {
  key: string;
  kind: UploadKind;
  phase: Extract<UploadPhase, "uploading" | "retrying" | "confirming" | "paused" | "ready" | "failed">;
  title: string;
  productName: string | null;
  packSurface: string | null;
  files: { field: string; name: string; bytes: number }[];
  pct: number;
  at: string;
  receipt: string | null;
  error: string | null;
};

export type PendingUploadOpenAction = "active" | "resume" | "start";

export function matchesDeskQuery(query: string, ...values: Array<string | undefined | null>): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return values.some((value) => String(value || "").toLocaleLowerCase().includes(needle));
}

export function receiptDisplayTitle(files: { name: string }[]): string {
  const first = files[0]?.name || "";
  return stemFromFilename(first) || first || "待开工文件";
}

export function shouldReconcileUpload(
  kind: UploadKind,
  local: UploadSnapshot | null,
  receipts: PendingUploadReceipt[],
): boolean {
  if (
    !local?.clientUploadId ||
    local.kind !== kind ||
    !["confirming", "retrying", "paused", "failed"].includes(local.phase)
  ) {
    return false;
  }
  return !receipts.some(
    (receipt) =>
      receipt.kind === kind && receipt.client_upload_id === local.clientUploadId,
  );
}

/** 待上传回执只属于有创建权限的人；读取失败不能连带清空可读的任务列表。 */
export async function loadDeskReceipts(
  canCreate: boolean,
  load: () => Promise<PendingUploadReceipt[]>,
): Promise<PendingUploadReceipt[]> {
  if (!canCreate) return [];
  try {
    return await load();
  } catch {
    return [];
  }
}

export function pendingUploadItems(
  kind: UploadKind,
  local: UploadSnapshot | null,
  receipts: PendingUploadReceipt[],
  query = "",
): PendingUploadItem[] {
  const out: PendingUploadItem[] = [];
  const seen = new Set<string>();
  const matchedReceipt = local
    ? receipts.find(
        (receipt) =>
          receipt.kind === kind &&
          (receipt.id === local.receipt ||
            Boolean(local.clientUploadId && receipt.client_upload_id === local.clientUploadId)),
      )
    : undefined;
  if (local && local.kind === kind && ["uploading", "retrying", "confirming", "paused", "ready", "failed"].includes(local.phase)) {
    const receipt = matchedReceipt?.id || local.receipt || null;
    const files = matchedReceipt?.files || local.files;
    const recoveredReady = matchedReceipt?.phase === "ready";
    const recoveredPaused = matchedReceipt?.phase === "paused";
    const phase = recoveredReady ? "ready" : recoveredPaused && !uploadIsLocallyBusy(local.phase) ? "paused" : local.phase;
    const received = matchedReceipt?.received ?? local.loaded;
    const total = matchedReceipt?.bytes ?? local.total;
    if (receipt) seen.add(receipt);
    out.push({
      key: receipt ? `receipt:${receipt}` : `active:${kind}`,
      kind,
      phase: phase as PendingUploadItem["phase"],
      title: local.productName.trim() || matchedReceipt?.product_name || receiptDisplayTitle(files),
      productName: local.productName.trim() || matchedReceipt?.product_name || null,
      packSurface: local.packSurface || matchedReceipt?.pack_surface || null,
      files,
      pct: total > 0 ? Math.round((received / total) * 100) : local.pct,
      at: matchedReceipt?.created_at || local.createdAt,
      receipt,
      error: recoveredReady ? null : local.error || null,
    });
  }
  for (const receipt of receipts) {
    if (receipt.kind !== kind || seen.has(receipt.id)) continue;
    out.push({
      key: `receipt:${receipt.id}`,
      kind,
      phase: receipt.phase,
      title: receipt.product_name || receiptDisplayTitle(receipt.files),
      productName: receipt.product_name || null,
      packSurface: receipt.pack_surface || null,
      files: receipt.files,
      pct: receipt.bytes > 0 ? Math.round((receipt.received / receipt.bytes) * 100) : 0,
      at: receipt.created_at,
      receipt: receipt.id,
      error: null,
    });
  }
  return out.filter((item) =>
    matchesDeskQuery(query, item.title, item.productName, ...item.files.map((file) => file.name)),
  );
}

export function pendingUploadCard(item: PendingUploadItem, readyLabel: string): DeskCardRow {
  const busy = uploadIsLocallyBusy(item.phase);
  const failed = item.phase === "failed";
  const paused = item.phase === "paused";
  return {
    id: item.key,
    shortId: item.receipt ? item.receipt.slice(0, 8) : "上传中",
    title: item.title,
    statusText: busy ? "上传中" : failed ? "上传失败" : paused ? "待继续上传" : readyLabel,
    statusColor: busy ? "processing" : failed ? "error" : "warning",
    at: item.at,
    live:
      item.phase === "confirming"
        ? "服务器确认中"
        : item.phase === "retrying"
          ? "网络波动，正在重连"
          : item.phase === "uploading"
            ? `已上传 ${item.pct}%`
            : paused
              ? `已保存 ${item.pct}%，点开继续`
              : null,
    progress: busy ? item.pct : undefined,
    error: failed ? item.error || "上传失败，请重新上传。" : null,
  };
}

/**
 * 看板只允许完整回执进入开工确认；其余状态回到上传工作台继续恢复。
 * 本机仍在传时不能用回执重挂载页面，否则会中断当前 XHR。
 */
export function pendingUploadOpenAction(item: PendingUploadItem): PendingUploadOpenAction {
  if (uploadIsLocallyBusy(item.phase)) return "active";
  if (item.phase !== "ready") return item.receipt ? "resume" : "active";
  if (!item.receipt) return "active";
  return item.productName ? "start" : "resume";
}

function uploadIsLocallyBusy(phase: UploadPhase): boolean {
  return phase === "uploading" || phase === "retrying" || phase === "confirming";
}
