import type { PendingUploadReceipt } from "../api";
import { uploadCanRetry, uploadPhaseLine, type UploadSnapshot } from "../uploadStore";
import { formatBytes } from "../pages/stemName";

export function UploadProgressSlot({
  snapshot,
  receipt,
  readyText,
  onRetry,
  onDiscard,
}: {
  snapshot?: UploadSnapshot | null;
  receipt?: PendingUploadReceipt | null;
  readyText: string;
  onRetry?: () => void;
  onDiscard?: () => void;
}) {
  const files = receipt?.files || snapshot?.files || [];
  if (files.length === 0) return null;
  const total = receipt?.bytes || snapshot?.total || files.reduce((sum, file) => sum + file.bytes, 0);
  const ready = receipt?.phase === "ready" || snapshot?.phase === "ready";
  const loaded = ready ? total : receipt?.received ?? snapshot?.loaded ?? 0;
  const pct = ready ? 100 : total > 0 ? Math.round((loaded / total) * 100) : snapshot?.pct || 0;
  const phase = receipt?.phase || snapshot?.phase || "draft";
  const line = ready
    ? readyText
    : receipt?.phase === "paused"
      ? "上传已暂停，服务器已保存收到的部分"
      : snapshot
        ? uploadPhaseLine(snapshot, readyText)
        : readyText;
  const canRetry = Boolean(onRetry && uploadCanRetry(snapshot));
  const serverDone = phase === "confirming" || ready;

  return (
    <div className={`upload-progress-slot is-${phase}`} aria-live="polite">
      <div className="upload-progress-head">
        <strong>{line}</strong>
        <div className="upload-progress-actions">
          <span>{pct}%</span>
          {canRetry ? (
            <button type="button" className="upload-progress-retry" onClick={onRetry}>
              继续上传
            </button>
          ) : null}
          {onDiscard ? (
            <button type="button" className="upload-progress-discard" onClick={onDiscard}>
              {ready ? "删除暂存" : phase === "paused" || phase === "failed" ? "放弃" : "停止并删除"}
            </button>
          ) : null}
        </div>
      </div>
      <div className="upload-progress-detail">
        <span className="upload-progress-files">{files.map((file) => file.name).join(" · ")}</span>
        <span className="upload-progress-bytes">
          {formatBytes(loaded)} / {formatBytes(total)}
        </span>
      </div>
      <div className="upload-progress-steps" aria-label="上传处理阶段">
        <span className="is-done">已选文件</span>
        <i>→</i>
        <span className={pct > 0 || ready ? "is-done" : ""}>上传到服务器</span>
        <i>→</i>
        <span className={serverDone ? "is-done" : ""}>服务器确认</span>
        <i>→</i>
        <span className={ready ? "is-done" : ""}>待开工</span>
      </div>
      <progress className="upload-progress-meter" max={100} value={pct} aria-label={line} />
    </div>
  );
}
