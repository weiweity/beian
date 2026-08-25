import type { ChangeEvent, DragEvent, ReactNode } from "react";
import { fileMatchesAccept } from "./fileAccept";
import { formatBytes } from "../pages/stemName";

type Props = {
  icon: string;
  title: string;
  hint: string;
  accept: string;
  fileName?: string;
  fileBytes?: number;
  disabled?: boolean;
  onFile: (file: File | null) => void;
  onReject?: (file: File) => void;
  children?: ReactNode;
};

export function UploadWell({
  icon,
  title,
  hint,
  accept,
  fileName,
  fileBytes,
  disabled,
  onFile,
  onReject,
  children,
}: Props) {
  function take(file: File | null, input?: HTMLInputElement) {
    if (file && !fileMatchesAccept(file, accept)) {
      if (input) input.value = "";
      onReject?.(file);
      return;
    }
    onFile(file);
  }

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0] || null;
    take(file, input);
    // 浏览器不会为同一路径再次触发 change；取走 File 后清空即可安全重选。
    input.value = "";
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    if (disabled) return;
    take(e.dataTransfer.files?.[0] || null);
  }

  return (
    <label
      className={fileName ? "upload-well has-file" : "upload-well"}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <input type="file" accept={accept} disabled={disabled} onChange={onChange} />
      <img className="upload-well-icon" src={icon} alt="" width={36} height={36} />
      <strong className="upload-well-title">{title}</strong>
      {fileName ? (
        <span className="upload-filechip">
          <span className="upload-filechip-name">{fileName}</span>
          {fileBytes != null ? <span className="upload-filechip-size">{formatBytes(fileBytes)}</span> : null}
          <span className="upload-filechip-ok">已选 · 点此更换</span>
        </span>
      ) : (
        <span className="upload-well-hint">{hint}</span>
      )}
      {children}
    </label>
  );
}
