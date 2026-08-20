import type { ChangeEvent, DragEvent, ReactNode } from "react";

type Props = {
  icon: string;
  title: string;
  hint: string;
  accept: string;
  fileName?: string;
  disabled?: boolean;
  onFile: (file: File | null) => void;
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
  children,
}: Props) {
  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null;
    onFile(f);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    if (disabled) return;
    const f = e.dataTransfer.files?.[0] || null;
    onFile(f);
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
