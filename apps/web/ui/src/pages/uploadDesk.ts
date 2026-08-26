import type { PendingUploadReceipt } from "../api";
import type { UploadKind, UploadPhase, UploadSnapshot } from "../uploadStore";
import type { DeskCardRow } from "./deskBoard";
import { stemFromFilename } from "./stemName";

export type PendingUploadItem = {
  key: string;
  kind: UploadKind;
  phase: Extract<UploadPhase, "uploading" | "confirming" | "ready" | "failed">;
  title: string;
  productName: string | null;
  files: { field: string; name: string; bytes: number }[];
  pct: number;
  at: string;
  receipt: string | null;
  error: string | null;
};

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
    (local.phase !== "confirming" && local.phase !== "failed")
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
  if (local && local.kind === kind && ["uploading", "confirming", "ready", "failed"].includes(local.phase)) {
    const receipt = matchedReceipt?.id || local.receipt || null;
    const files = matchedReceipt?.files || local.files;
    const recovered = Boolean(matchedReceipt);
    if (receipt) seen.add(receipt);
    out.push({
      key: receipt ? `receipt:${receipt}` : `active:${kind}`,
      kind,
      phase: (recovered ? "ready" : local.phase) as PendingUploadItem["phase"],
      title: local.productName.trim() || receiptDisplayTitle(files),
      productName: local.productName.trim() || null,
      files,
      pct: recovered ? 100 : local.pct,
      at: matchedReceipt?.created_at || local.createdAt,
      receipt,
      error: recovered ? null : local.error || null,
    });
  }
  for (const receipt of receipts) {
    if (receipt.kind !== kind || seen.has(receipt.id)) continue;
    out.push({
      key: `receipt:${receipt.id}`,
      kind,
      phase: "ready",
      title: receiptDisplayTitle(receipt.files),
      productName: null,
      files: receipt.files,
      pct: 100,
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
  const busy = item.phase === "uploading" || item.phase === "confirming";
  const failed = item.phase === "failed";
  return {
    id: item.key,
    shortId: item.receipt ? item.receipt.slice(0, 8) : "上传中",
    title: item.title,
    statusText: busy ? "上传中" : failed ? "上传失败" : readyLabel,
    statusColor: busy ? "processing" : failed ? "error" : "warning",
    at: item.at,
    live: item.phase === "confirming" ? "服务器确认中" : item.phase === "uploading" ? `已上传 ${item.pct}%` : null,
    progress: busy ? item.pct : undefined,
    error: failed ? item.error || "上传失败，请重新上传。" : null,
  };
}
