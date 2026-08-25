import { useState } from "react";
import { App } from "antd";
import { api } from "../api";
import { UploadWell } from "../chrome/UploadWell";
import { WaitCard } from "../chrome/WaitCard";
import { stemFromFilename } from "./stemName";
import { UPLOAD_TOO_LARGE, bytesTooLarge } from "../uploadLimit";

type Props = { onCreated: (id: string) => void; onBack: () => void };

export function NewTaskPage({ onCreated, onBack }: Props) {
  const { message } = App.useApp();
  const [productName, setProductName] = useState("");
  const [pack, setPack] = useState("carton");
  const [excel, setExcel] = useState<File | null>(null);
  const [pdf, setPdf] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const name = productName.trim();
    if (!name) {
      message.warning("品名必填。");
      return;
    }
    if (!excel || !pdf) {
      message.warning("请同时选择 Excel 和包装 PDF。");
      return;
    }
    if (bytesTooLarge(excel.size, pdf.size)) {
      message.error(UPLOAD_TOO_LARGE);
      return;
    }
    const fd = new FormData();
    fd.append("product_name", name);
    fd.append("title", name);
    fd.append("pack_surface", pack);
    fd.append("excel", excel);
    fd.append("pdf", pdf);
    setSubmitting(true);
    try {
      const task = await api.uploadExcelPdf(fd);
      message.success("已开始对照。结论还要你来定。");
      onCreated(task.id);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "上传失败");
      setSubmitting(false);
    }
  }

  function takeExcel(file: File | null) {
    setExcel(file);
    if (file) {
      message.success("已选 Excel 确认单");
      if (!productName.trim()) setProductName(stemFromFilename(file.name));
    }
  }

  function takePdf(file: File | null) {
    setPdf(file);
    if (file) {
      message.success("已选包装 PDF");
      if (!productName.trim()) setProductName(stemFromFilename(file.name));
    }
  }

  if (submitting) return <WaitCard job="对照" jobStatus="queued" />;

  return (
    <section className="new-form">
      <header className="page-head">
        <div>
          <h1 className="page-title">新建 Excel↔PDF</h1>
          <p className="page-lead">一次只传一对。机审只标疑点。</p>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回
          </button>
          <button type="button" className="btn-primary" onClick={() => void submit()}>
            开始对照
          </button>
        </div>
      </header>

      <div className="new-meta">
        <label className="new-meta-name">
          品名
          <input
            maxLength={80}
            placeholder="选 Excel 后自动填，可改"
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
          />
        </label>
        <div className="new-meta-pack">
          <span>包装面</span>
          <div className="pack-pills">
            <button
              type="button"
              className={pack === "carton" ? "pack-pill is-on" : "pack-pill"}
              onClick={() => setPack("carton")}
            >
              花盒
            </button>
            <button
              type="button"
              className={pack === "pouch" ? "pack-pill is-on" : "pack-pill"}
              onClick={() => setPack("pouch")}
            >
              膜袋
            </button>
          </div>
        </div>
      </div>

      <div className="upload-row">
        <UploadWell
          icon="/brand/ui/well-excel.svg"
          title="Excel 确认单"
          hint="把 .xlsx 拖进来，或点选取"
          accept=".xlsx"
          fileName={excel?.name}
          fileBytes={excel?.size}
          onFile={takeExcel}
          onReject={() => message.warning("Excel 只要 .xlsx。")}
        >
          <span className="upload-well-btn">选取 Excel</span>
        </UploadWell>
        <UploadWell
          icon="/brand/ui/well-pdf.svg"
          title="包装 PDF"
          hint="花盒或膜袋展开图"
          accept=".pdf"
          fileName={pdf?.name}
          fileBytes={pdf?.size}
          onFile={takePdf}
          onReject={() => message.warning("包装稿只要 PDF。")}
        >
          <span className="upload-well-btn">选取 PDF</span>
        </UploadWell>
      </div>

      <p className="new-ocr-hint">OCR 认不清会写成「待人工确认」，不会自动过审。一次只传一对。</p>

      <div className="step-row">
        <article className="step-card">
          <b>1</b>
          <strong>传一对</strong>
          <p>Excel 确认单和包装展开图一次只传一对。</p>
        </article>
        <article className="step-card">
          <b>2</b>
          <strong>机审标疑点</strong>
          <p>认不清就写成待人工确认，不会自动过审。</p>
        </article>
        <article className="step-card">
          <b>3</b>
          <strong>她来签字</strong>
          <p>人话结论。待签在上，点开核对页一对一对。</p>
        </article>
      </div>
    </section>
  );
}
