import type { ChangeEvent, DragEvent, ReactNode } from "react";
import { fileMatchesAccept } from "./fileAccept";

type Props = {
  icon: string;
  title: string;
  hint: string;
  accept: string;
  fileName?: string;
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
    take(e.target.files?.[0] || null, e.target);
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
      <span className="upload-well-hint">{fileName || hint}</span>
      {children}
    </label>
  );
}
