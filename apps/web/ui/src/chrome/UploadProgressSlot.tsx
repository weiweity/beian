import type { PendingUploadReceipt } from "../api";
import { uploadPhaseLine, type UploadSnapshot } from "../uploadStore";
import { formatBytes } from "../pages/stemName";

export function UploadProgressSlot({
  snapshot,
  receipt,
  readyText,
  onDiscard,
}: {
  snapshot?: UploadSnapshot | null;
  receipt?: PendingUploadReceipt | null;
  readyText: string;
  onDiscard?: () => void;
}) {
  const files = receipt?.files || snapshot?.files || [];
  if (files.length === 0) return null;
  const total = receipt?.bytes || snapshot?.total || files.reduce((sum, file) => sum + file.bytes, 0);
  const ready = Boolean(receipt) || snapshot?.phase === "ready";
  const loaded = ready ? total : snapshot?.loaded || 0;
  const pct = ready ? 100 : snapshot?.pct || 0;
  const phase = receipt ? "ready" : snapshot?.phase || "draft";
  const line = receipt ? readyText : snapshot ? uploadPhaseLine(snapshot, readyText) : readyText;

  return (
    <div className={`upload-progress-slot is-${phase}`} aria-live="polite">
      <div className="upload-progress-head">
        <strong>{line}</strong>
        <div className="upload-progress-actions">
          <span>{pct}%</span>
          {onDiscard ? (
            <button type="button" className="upload-progress-discard" onClick={onDiscard}>
              放弃上传
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
      <progress className="upload-progress-meter" max={100} value={pct} aria-label={line} />
    </div>
  );
}
