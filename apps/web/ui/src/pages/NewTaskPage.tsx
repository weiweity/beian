import { useEffect, useRef, useState } from "react";
import { Alert, App } from "antd";
import { api, type PendingUploadReceipt } from "../api";
import { UploadProgressSlot } from "../chrome/UploadProgressSlot";
import { UploadWell } from "../chrome/UploadWell";
import { rememberReviewHandoff } from "../jobHandoff";
import {
  uploadIsBusy,
  uploadStore,
  useUploadReceiptRecovery,
  useUploadSnapshot,
  type UploadSnapshot,
} from "../uploadStore";
import { stemFromFilename } from "./stemName";

type Props = {
  canCreate: boolean;
  receiptId?: string | null;
  onCreated: (id: string) => void;
  onBack: () => void;
};

function receiptFromSnapshot(snapshot: UploadSnapshot | null): PendingUploadReceipt | null {
  if (!snapshot?.receipt || snapshot.phase !== "ready") return null;
  return {
    id: snapshot.receipt,
    files: snapshot.files.map((file) => ({ ...file, received: file.bytes, last_modified: file.lastModified })),
    bytes: snapshot.files.reduce((sum, file) => sum + file.bytes, 0),
    received: snapshot.files.reduce((sum, file) => sum + file.bytes, 0),
    created_at: snapshot.createdAt,
    kind: snapshot.kind,
    phase: "ready",
  };
}

export function NewTaskPage({ canCreate, receiptId, onCreated, onBack }: Props) {
  const { message, modal } = App.useApp();
  const upload = useUploadSnapshot("compare");
  const localReceipt = receiptFromSnapshot(upload);
  const localMatches = Boolean(receiptId && localReceipt?.id === receiptId);
  const [resumeSource, setResumeSource] = useState<"local" | "remote">(() => (!receiptId || localMatches ? "local" : "remote"));
  const [restoredReceipt, setRestoredReceipt] = useState<PendingUploadReceipt | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [productName, setProductName] = useState(resumeSource === "local" ? upload?.productName || "" : "");
  const [pack, setPack] = useState(resumeSource === "local" ? upload?.packSurface || "carton" : "carton");
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(false);
  useUploadReceiptRecovery("compare", upload, canCreate && resumeSource === "local");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (resumeSource !== "local" || !upload) return;
    setProductName(upload.productName || "");
    setPack(upload.packSurface || "carton");
  }, [resumeSource, upload?.clientUploadId, upload?.productName, upload?.packSurface]);

  useEffect(() => {
    if (!canCreate || resumeSource === "local" || !receiptId) {
      setRestoredReceipt(null);
      setResumeError(null);
      return;
    }
    let cancelled = false;
    setResumeError(null);
    void api
      .uploads()
      .then((list) => {
        if (cancelled) return;
        const found = list.find((item) => item.id === receiptId && item.kind === "compare") || null;
        if (found?.phase === "paused") {
          uploadStore.restore("compare", found);
          setProductName(found.product_name || "");
          setPack(found.pack_surface || "carton");
          setResumeSource("local");
          setRestoredReceipt(null);
          return;
        }
        setRestoredReceipt(found);
        if (found) {
          setProductName(found.product_name || "");
          setPack(found.pack_surface || "carton");
        } else {
          setResumeError("这份上传回执已过期或已经开工，请返回审稿台刷新。");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setResumeError(err instanceof Error ? err.message : "上传回执读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [canCreate, receiptId, resumeSource]);

  const receipt = resumeSource === "local" ? upload?.receipt || null : restoredReceipt?.id || null;
  const files = resumeSource === "local" ? upload?.files || [] : restoredReceipt?.files || [];
  const excel = files.find((file) => file.field === "excel");
  const pdf = files.find((file) => file.field === "pdf");
  const busy = resumeSource === "local" && uploadIsBusy(upload);

  function updateName(next: string) {
    setProductName(next);
    if (resumeSource === "local") uploadStore.updateMeta("compare", { productName: next });
  }

  function updatePack(next: string) {
    setPack(next);
    if (resumeSource === "local") uploadStore.updateMeta("compare", { packSurface: next });
  }

  function takeFile(field: "excel" | "pdf", file: File | null) {
    let name = productName;
    if (file && !name.trim()) {
      name = stemFromFilename(file.name);
      setProductName(name);
    }
    const next = uploadStore.replaceFile("compare", field, file, { productName: name, packSurface: pack });
    if (next.phase === "failed" && next.error) message.error(next.error);
    else if (file) message.success(field === "excel" ? "已选 Excel 确认单" : "已选包装 PDF");
  }

  async function submit() {
    const name = productName.trim();
    if (!name) {
      message.warning("品名必填。");
      return;
    }
    if (!receipt) {
      message.warning("请先等文件传完。");
      return;
    }
    setSubmitting(true);
    try {
      const task = await api.startTask({
        receipt,
        product_name: name,
        title: name,
        pack_surface: pack,
      });
      uploadStore.clear("compare", receipt);
      rememberReviewHandoff(task);
      if (!mounted.current) return;
      message.success("已开始对照。结论还要你来定。");
      onCreated(task.id);
    } catch (err) {
      if (mounted.current) message.error(err instanceof Error ? err.message : "无法开始对照");
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  function confirmAbandon() {
    modal.confirm({
      title: "放弃这次上传？",
      content: "暂存文件会删除；以后需要时要重新选择并上传。",
      okText: "放弃上传",
      okButtonProps: { danger: true },
      cancelText: "继续保留",
      onOk: async () => {
        try {
          if (resumeSource === "remote" && restoredReceipt) {
            const result = await api.discardUpload(restoredReceipt.id);
            if (!result.ok) throw new Error("这份上传已经过期或已经开工");
            setRestoredReceipt(null);
          } else {
            await uploadStore.abandon("compare");
          }
          message.success("已放弃这次上传，文件资源已释放。");
          onBack();
        } catch (err) {
          message.error(err instanceof Error ? err.message : "无法放弃这次上传");
          throw err;
        }
      },
    });
  }

  if (!canCreate) {
    return (
      <section className="new-form">
        <header className="page-head">
          <h1 className="page-title">新建 Excel↔PDF</h1>
          <button type="button" className="btn-ghost" onClick={onBack}>返回</button>
        </header>
        <Alert type="warning" showIcon title="当前账号只有查看权限，不能上传或新建审核单。" />
      </section>
    );
  }

  return (
    <section className="new-form">
      <header className="page-head">
        <div>
          <h1 className="page-title">新建 Excel↔PDF</h1>
          <p className="page-lead">一次只传一对。机审只标疑点。</p>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" className="btn-ghost" disabled={submitting} onClick={onBack}>
            返回
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!receipt || busy || submitting}
            onClick={() => void submit()}
          >
            {submitting ? "正在开工" : busy ? "上传中" : "开始对照"}
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
            onChange={(event) => updateName(event.target.value)}
          />
        </label>
        <div className="new-meta-pack">
          <span>包装面</span>
          <div className="pack-pills">
            <button
              type="button"
              className={pack === "carton" ? "pack-pill is-on" : "pack-pill"}
              onClick={() => updatePack("carton")}
            >
              花盒
            </button>
            <button
              type="button"
              className={pack === "pouch" ? "pack-pill is-on" : "pack-pill"}
              onClick={() => updatePack("pouch")}
            >
              膜袋
            </button>
          </div>
        </div>
      </div>

      {resumeError ? <Alert type="error" showIcon title={resumeError} /> : null}
      <UploadProgressSlot
        snapshot={resumeSource === "local" ? upload : null}
        receipt={resumeSource === "remote" ? restoredReceipt : null}
        readyText="上传成功，可以开始对照"
        onRetry={resumeSource === "local" ? () => uploadStore.retry("compare") : undefined}
        onDiscard={files.length ? confirmAbandon : undefined}
      />

      <div className="upload-row">
        <UploadWell
          icon="/brand/ui/well-excel.svg"
          title="Excel 确认单"
          hint="把 .xlsx 拖进来，或点选取"
          accept=".xlsx"
          fileName={excel?.name}
          fileBytes={excel?.bytes}
          disabled={resumeSource === "remote"}
          onFile={(file) => takeFile("excel", file)}
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
          fileBytes={pdf?.bytes}
          disabled={resumeSource === "remote"}
          onFile={(file) => takeFile("pdf", file)}
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
