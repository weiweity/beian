import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, ConfigProvider, Empty, Input, Segmented, Space, Table, Tag, theme as antdTheme } from "antd";
import { api, ApiError, isUploadReceiptExpired, UPLOAD_TIMEOUT_MS, type MockupJob, type PendingUploadReceipt } from "../api";
import {
  forgetMockupHandoff,
  mockupHandoffFor,
  rememberMockupHandoff,
} from "../jobHandoff";
import { UploadProgressSlot } from "../chrome/UploadProgressSlot";
import { UploadWell } from "../chrome/UploadWell";
import { WaitCard } from "../chrome/WaitCard";
import { mockupFailReason, mockupFailTag } from "./mockupError";
import { AdminRotateFront, StructureConfirmPanel } from "./StructureConfirmPanel";
import { RenderVersions } from "./RenderVersions";
import { structureIssueCopy, structureStatusLabel } from "./mockupStructure";
import { liveJobLine, mockupBoardProgress, shouldShowWaitCard } from "./waitCard";
import { stemFromFilename } from "./stemName";
import { HUD_MS, FULL_UPGRADE_NOTICE, allowFullUpgradeNotice, downloadHudLine, missingPptHud, type HudNoticeSource } from "./mockupHud";
import { panBy, resetZoom, zoomAt, zoomCss, type ZoomState } from "./canvasZoom";
import { listedReadFaces, READ_FACE_LABEL, readFaceKey } from "./mockupReadFaces";
import {
  BACKDROP_LABEL,
  BACKDROP_PRESETS,
  backdropFrameClass,
  blobFromLitStill,
  blobFromStudioStill,
  canvasFilterSupported,
  clampStudioLight,
  applyStudioPreviewDataset,
  composeStudioStill,
  loadStudioPreview,
  observeStudioFrame,
  peekSettled,
  planStudioExport,
  studioAssetHref,
  studioDrawnLayerKeys,
  studioDrawnUpgradeFailed,
  glbExposure,
  jobHasGround,
  jobHasReviewCard,
  jobHasSet,
  loadStillImage,
  canvasBackingSize,
  prepareStudioCanvas,
  releaseCanvasBacking,
  releaseStudioGeneration,
  stillSetKey,
  parseBackdropPreset,
  readBackdropPreset,
  reviewCardKey,
  studioBackdrop,
  writeBackdropPreset,
  type StudioPreviewSources,
  type BackdropPreset,
  STUDIO_LIGHT_DEFAULT,
  STUDIO_LIGHT_MAX,
  STUDIO_LIGHT_MIN,
} from "./mockupStudio";
import { deskClock, type DeskCardRow } from "./deskBoard";
import { DeskCol } from "./DeskCol";
import { shouldShowTaskBoard } from "./tasksBoard";
import {
  uploadIsBusy,
  UPLOAD_RECOVERY_INTERVAL_MS,
  uploadStore,
  useUploadReceiptRecovery,
  useUploadSnapshot,
  type UploadSnapshot,
} from "../uploadStore";
import {
  matchesDeskQuery,
  loadDeskReceipts,
  pendingUploadCard,
  pendingUploadOpenAction,
  pendingUploadItems,
  shouldReconcileUpload,
  type PendingUploadItem,
} from "./uploadDesk";
import {
  enterElementFullscreen,
  exitElementFullscreen,
  isElementFullscreen,
  pingViewerAfterFullscreen,
} from "./mockupFullscreen";
import { ModelViewerElement } from "@google/model-viewer";
// Version changes disconnect the old scene. Keep no unreferenced glTF texture/geometry cache.
// model-viewer's public cache policy still retains resources used by a live viewer.
ModelViewerElement.modelCacheSize = 0;

type DeskProps = {
  canCreate: boolean;
  onOpenJob: (id: string) => void;
  onCompose: () => void;
  onResumeReceipt: (receipt: string) => void;
};
type JobProps = { jobId: string; onBack: () => void };
type Layout = "board" | "table";

function mockLabel(row: MockupJob) {
  if (row.status === "done") return { text: "已出图", color: "success" as const };
  if (row.structure_status === "review_required") {
    return row.structure_code === "structure_face_mapping_incomplete"
      ? { text: "待选正面", color: "warning" as const }
      : { text: "打样失败", color: "error" as const };
  }
  if (row.structure_status === "unsupported") return { text: "结构暂不支持", color: "error" as const };
  if (row.status === "failed") return { text: mockupFailTag(), color: "error" as const };
  if (row.status === "queued" || row.status === "running") return { text: "打样中", color: "processing" as const };
  return { text: row.status, color: "default" as const };
}

function mockCol(row: MockupJob): "running" | "failed" | "done" {
  if (row.status === "done") return "done";
  if (row.status === "failed" || row.status === "unsupported" || row.job_status === "failed") return "failed";
  if (row.structure_status === "unsupported") return "failed";
  if (row.structure_status === "review_required" && row.structure_code !== "structure_face_mapping_incomplete") {
    return "failed";
  }
  return "running";
}

function mockTitle(row: MockupJob) {
  return row.title || row.files[0]?.name || row.id.slice(0, 8);
}

function fileHref(jobId: string, key: string, download = false, generation = "") {
  return studioAssetHref(jobId, key, generation, download);
}

export function MockupDesk({
  openId,
  composing,
  receiptId,
  canCreate,
  canConfirmStructure,
  canAdmin,
  onOpenJob,
  onBack,
  onCompose,
  onResumeReceipt,
}: {
  openId?: string | null;
  composing?: boolean;
  receiptId?: string | null;
  canCreate: boolean;
  canConfirmStructure: boolean;
  canAdmin?: boolean;
  onOpenJob: (id: string) => void;
  onBack: () => void;
  onCompose?: () => void;
  onResumeReceipt: (receipt: string) => void;
}) {
  let content: ReactNode;
  if (openId) {
    content = (
      <MockupJobPage
        key={openId}
        jobId={openId}
        canCreate={canCreate}
        canConfirmStructure={canConfirmStructure}
        canAdmin={canAdmin}
        onBack={onBack}
      />
    );
  } else if (composing) {
    content = <MockupNewPage key={receiptId || "active"} canCreate={canCreate} receiptId={receiptId} onCreated={onOpenJob} onBack={onBack} />;
  } else {
    content = (
      <MockupPage
        canCreate={canCreate}
        onOpenJob={onOpenJob}
        onCompose={onCompose || (() => undefined)}
        onResumeReceipt={onResumeReceipt}
      />
    );
  }
  return (
    <ConfigProvider
      theme={{
        algorithm: antdTheme.defaultAlgorithm,
        token: { colorPrimary: "#805898", colorText: "#1c1a1f", colorBgBase: "#ffffff" },
      }}
    >
      {content}
    </ConfigProvider>
  );
}

function toMockCard(row: MockupJob): DeskCardRow {
  const s = mockLabel(row);
  return {
    id: row.id,
    title: mockTitle(row),
    statusText: s.text,
    statusColor: s.color,
    actor: row.owner,
    at: row.job_started_at || row.created_at,
    progress: mockupBoardProgress(row),
    live: liveJobLine({ ...row, kind: "mockup" }),
    error:
      row.structure_status === "review_required"
        ? structureIssueCopy(row)
        : row.structure_status === "unsupported"
          ? structureIssueCopy(row)
          : row.status === "failed"
            ? mockupFailReason(row.error || row.job_error)
            : null,
  };
}

export function MockupPage({
  canCreate,
  onOpenJob,
  onCompose,
  onResumeReceipt,
}: DeskProps) {
  const { message, modal } = App.useApp();
  const localUpload = useUploadSnapshot("mockup");
  const [rows, setRows] = useState<MockupJob[]>([]);
  const [receipts, setReceipts] = useState<PendingUploadReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [layout, setLayout] = useState<Layout>("board");
  const [reload, setReload] = useState(0);
  const listGen = useRef(0);
  const pendingStarts = useRef(new Set<string>());

  function refreshList() {
    const gen = ++listGen.current;
    return api
      .mockups()
      .then((list) => {
        if (gen !== listGen.current) return list;
        setRows(list);
        return list;
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    let cancelled = false;
    const gen = ++listGen.current;
    setLoading(true);
    setError(null);
    void Promise.all([api.mockups(), loadDeskReceipts(canCreate, api.uploads)])
      .then(([list, pending]) => {
        if (cancelled || gen !== listGen.current) return;
        setRows(list);
        for (const receipt of pending) uploadStore.recover("mockup", receipt);
        setReceipts(pending);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败，再试一次");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canCreate, reload]);

  const boardLive = rows.some((row) => row.job_status === "queued" || row.job_status === "running");
  useEffect(() => {
    if (!boardLive) return;
    const id = window.setInterval(() => {
      void refreshList();
    }, 2500);
    return () => window.clearInterval(id);
  }, [boardLive]);

  const reconcileUpload = shouldReconcileUpload("mockup", localUpload, receipts);
  useEffect(() => {
    if (!canCreate || !reconcileUpload) return;
    let cancelled = false;
    const reconcile = () => {
      void api
        .uploads()
        .then((pending) => {
          if (cancelled) return;
          for (const receipt of pending) uploadStore.recover("mockup", receipt);
          setReceipts(pending);
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
  }, [canCreate, localUpload?.clientUploadId, localUpload?.phase, reconcileUpload]);

  const filteredRows = useMemo(
    () =>
      rows.filter((row) =>
        matchesDeskQuery(submitted, mockTitle(row), ...row.files.map((file) => file.name)),
      ),
    [rows, submitted],
  );
  const allPendingItems = useMemo(
    () => pendingUploadItems("mockup", localUpload, receipts),
    [localUpload, receipts],
  );
  const pendingItems = useMemo(
    () => pendingUploadItems("mockup", localUpload, receipts, submitted),
    [localUpload, receipts, submitted],
  );
  const pendingCards = useMemo(
    () => pendingItems.map((item) => pendingUploadCard(item, "待打样")),
    [pendingItems],
  );
  const pendingByKey = useMemo(() => new Map(pendingItems.map((item) => [item.key, item])), [pendingItems]);
  const board = useMemo(
    () => ({
      running: filteredRows.filter((row) => mockCol(row) === "running"),
      failed: filteredRows.filter((row) => mockCol(row) === "failed"),
      done: filteredRows.filter((row) => mockCol(row) === "done"),
    }),
    [filteredRows],
  );
  const totalCount = filteredRows.length + pendingItems.length;
  const allCount = rows.length + allPendingItems.length;
  const showSearch = Boolean(submitted) || allCount > 0;
  const showBoard = shouldShowTaskBoard(totalCount, submitted) && totalCount > 0;
  const tableRows = useMemo(
    () => [...pendingCards, ...filteredRows.map(toMockCard)],
    [pendingCards, filteredRows],
  );

  function openPending(item: PendingUploadItem) {
    const action = pendingUploadOpenAction(item);
    if (action === "active") {
      onCompose();
      return;
    }
    if (action === "resume") {
      if (!item.receipt) return;
      onResumeReceipt(item.receipt);
      return;
    }
    if (!item.receipt || !item.productName) return;
    const receipt = item.receipt;
    const productName = item.productName;
    modal.confirm({
      title: "开始打样这单？",
      content: `品名：${productName}。上传文件已由服务器确认，开始后会进入打样队列。`,
      okText: "开始打样",
      cancelText: "先不开始",
      onOk: async () => {
        if (pendingStarts.current.has(receipt)) return;
        pendingStarts.current.add(receipt);
        try {
          const next = await api.startMockup({ receipt, title: productName, product_name: productName });
          uploadStore.clear("mockup", receipt);
          setReceipts((current) => current.filter((saved) => saved.id !== receipt));
          message.success("已开始打样。");
          rememberMockupHandoff(next);
          onOpenJob(next.id);
        } catch (err) {
          if (isUploadReceiptExpired(err)) {
            uploadStore.clear("mockup", receipt);
            setReceipts((current) => current.filter((saved) => saved.id !== receipt));
            void refreshList();
            message.warning("这份上传已开工或过期，列表已刷新。");
          } else {
            message.error(err instanceof Error ? err.message : "无法开始打样");
          }
        } finally {
          pendingStarts.current.delete(receipt);
        }
      },
    });
  }

  function openCard(id: string) {
    const pending = pendingByKey.get(id);
    if (pending) openPending(pending);
    else onOpenJob(id);
  }

  return (
    <section className="mockup-desk">
      <div className="desk-head">
        <div>
          <h1 className="page-title">打样台</h1>
          <p className="page-lead">交差「盒子长什么样」。点进度或已出图进打样单。</p>
        </div>
        <Space wrap>
          {showSearch ? (
            <Input.Search
              allowClear
              placeholder="搜品名或文件名"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              onClear={() => {
                setQ("");
                setSubmitted("");
              }}
              onSearch={(value) => setSubmitted(value.trim())}
              style={{ width: 240 }}
            />
          ) : null}
          {showBoard ? (
            <Segmented
              value={layout}
              onChange={(value) => setLayout(value as Layout)}
              options={[
                { label: "看板", value: "board" },
                { label: "表格", value: "table" },
              ]}
            />
          ) : null}
          {canCreate ? (
            <Button type="primary" onClick={onCompose}>
              进入工作台
            </Button>
          ) : null}
        </Space>
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title={error}
          action={
            <Button size="small" onClick={() => setReload((count) => count + 1)}>
              再试一次
            </Button>
          }
        />
      ) : null}
      {!showBoard ? (
        <div className="desk-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              loading ? (
                <div>读取打样单…</div>
              ) : submitted ? (
                <div>没有找到这个品名或文件名</div>
              ) : (
                <div>
                  <div>还没有打样单</div>
                  <div className="desk-empty-hint">右上角进入工作台，交一份 .ai 平面稿</div>
                </div>
              )
            }
          >
            {loading ? null : submitted ? (
              <Button
                onClick={() => {
                  setQ("");
                  setSubmitted("");
                }}
              >
                清空
              </Button>
            ) : canCreate ? (
              <Button type="primary" onClick={onCompose}>
                进入工作台
              </Button>
            ) : null}
          </Empty>
        </div>
      ) : layout === "board" ? (
        <div className="review-board">
          <DeskCol
            title="打样中"
            hint="上传中、待打样或机器运行"
            rows={[...pendingCards, ...board.running.map(toMockCard)]}
            onOpen={openCard}
          />
          <DeskCol title="打样失败" hint="点进去看原因" rows={board.failed.map(toMockCard)} onOpen={onOpenJob} />
          <DeskCol title="已出图" hint="点进去打开打样单" rows={board.done.map(toMockCard)} onOpen={onOpenJob} />
        </div>
      ) : (
        <Table<DeskCardRow>
          rowKey="id"
          loading={loading}
          dataSource={tableRows}
          pagination={false}
          scroll={{ x: 760 }}
          onRow={(row) => ({ onClick: () => openCard(row.id), style: { cursor: "pointer" } })}
          columns={[
            { title: "品名 / 文件", dataIndex: "title" },
            {
              title: "状态",
              width: 180,
              render: (_, row) => (
                <div>
                  <Tag color={row.statusColor}>{row.statusText}</Tag>
                  {row.live ? <div className="review-card-live">{row.live}</div> : null}
                </div>
              ),
            },
            { title: "工作时间", dataIndex: "at", width: 180, render: (value: string) => deskClock(value) },
            { title: "使用人", dataIndex: "actor", width: 100, render: (value: string) => value || "—" },
            { title: "", key: "open", width: 100, render: () => <Button type="link">打开</Button> },
          ]}
        />
      )}
    </section>
  );
}

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

export function MockupNewPage({
  canCreate,
  receiptId,
  onCreated,
  onBack,
}: {
  canCreate: boolean;
  receiptId?: string | null;
  onCreated: (id: string) => void;
  onBack: () => void;
}) {
  const { message, modal } = App.useApp();
  const upload = useUploadSnapshot("mockup");
  const localReceipt = receiptFromSnapshot(upload);
  const localMatches = Boolean(receiptId && localReceipt?.id === receiptId);
  const [resumeSource, setResumeSource] = useState<"local" | "remote">(() => (!receiptId || localMatches ? "local" : "remote"));
  const [restoredReceipt, setRestoredReceipt] = useState<PendingUploadReceipt | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [productName, setProductName] = useState(resumeSource === "local" ? upload?.productName || "" : "");
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(false);
  const startLock = useRef(false);
  useUploadReceiptRecovery("mockup", upload, canCreate && resumeSource === "local");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (resumeSource !== "local" || !upload) return;
    setProductName(upload.productName || "");
  }, [resumeSource, upload?.clientUploadId, upload?.productName]);

  useEffect(() => {
    if (!canCreate || !receiptId) {
      setRestoredReceipt(null);
      setResumeError(null);
      return;
    }
    if (resumeSource === "local") {
      setRestoredReceipt(null);
      return;
    }
    let cancelled = false;
    setResumeError(null);
    void api
      .uploads()
      .then((list) => {
        if (cancelled) return;
        const found = list.find((item) => item.id === receiptId && item.kind === "mockup") || null;
        if (found?.phase === "paused") {
          uploadStore.restore("mockup", found);
          setProductName(found.product_name || "");
          setResumeSource("local");
          setRestoredReceipt(null);
          return;
        }
        setRestoredReceipt(found);
        if (found) {
          setProductName(found.product_name || "");
        } else {
          setResumeError("这份上传回执已过期或已经开工，请返回打样台刷新。");
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
  const ai = files.find((file) => file.field === "file" || file.field === "ai");
  const busy = resumeSource === "local" && uploadIsBusy(upload);

  function updateName(next: string) {
    setProductName(next);
    if (resumeSource === "local") uploadStore.updateMeta("mockup", { productName: next });
  }

  function takeFile(next: File | null) {
    if (next) setResumeError(null);
    let name = productName;
    if (next && !name.trim()) {
      name = stemFromFilename(next.name);
      setProductName(name);
    }
    const state = uploadStore.replaceFile("mockup", "ai", next, { productName: name });
    if (state.phase === "failed" && state.error) message.error(state.error);
    else if (next) message.success("已选平面稿");
  }

  async function run() {
    if (startLock.current) return;
    const name = productName.trim();
    if (!name) {
      message.warning("品名必填。");
      return;
    }
    if (!receipt) {
      message.warning("请先等文件传完。");
      return;
    }
    startLock.current = true;
    setSubmitting(true);
    try {
      const next = await api.startMockup({
        receipt,
        title: name,
        product_name: name,
      });
      uploadStore.clear("mockup", receipt);
      rememberMockupHandoff(next);
      if (!mounted.current) return;
      onCreated(next.id);
    } catch (err) {
      if (!mounted.current) return;
      if (isUploadReceiptExpired(err)) {
        uploadStore.clear("mockup", receipt);
        setRestoredReceipt(null);
        setResumeSource("local");
        setResumeError("这份上传已开工或过期，请重新选择文件上传。");
        message.warning("上传回执已失效，请重新上传。");
      } else {
        message.error(err instanceof Error ? err.message : "打样失败");
      }
    } finally {
      startLock.current = false;
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
            await uploadStore.abandon("mockup");
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
      <section className="new-form mockup-desk">
        <header className="page-head">
          <h1 className="page-title">打样工作台</h1>
          <button type="button" className="btn-ghost" onClick={onBack}>返回</button>
        </header>
        <Alert type="warning" showIcon title="当前账号只有查看权限，不能上传或新建打样单。" />
      </section>
    );
  }

  return (
    <section className="new-form mockup-desk">
      <header className="page-head">
        <div>
          <h1 className="page-title">打样工作台</h1>
          <p className="page-lead">先交平面稿。本机要有 Blender。</p>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" className="btn-ghost" disabled={submitting} onClick={onBack}>
            返回
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!receipt || busy || submitting}
            onClick={() => void run()}
          >
            {submitting ? "正在开工" : busy ? "上传中" : "开始打样"}
          </button>
        </div>
      </header>
      <div className="new-meta">
        <label className="new-meta-name">
          品名
          <input
            maxLength={80}
            placeholder="选平面稿后自动填，可改"
            value={productName}
            onChange={(event) => updateName(event.target.value)}
          />
        </label>
      </div>
      {resumeError ? <Alert type="error" showIcon title={resumeError} /> : null}
      <UploadProgressSlot
        snapshot={resumeSource === "local" ? upload : null}
        receipt={resumeSource === "remote" ? restoredReceipt : null}
        readyText="上传成功，可以开始打样"
        onRetry={resumeSource === "local" ? () => uploadStore.retry("mockup") : undefined}
        onDiscard={files.length ? confirmAbandon : undefined}
      />
      <div className="upload-row is-single">
        <UploadWell
          icon="/brand/ui/well-pdf.svg"
          title="平面稿"
          hint="把 .ai 拖到这里"
          accept=".ai"
          fileName={ai?.name}
          fileBytes={ai?.bytes}
          disabled={resumeSource === "remote"}
          onFile={takeFile}
          onReject={() => message.warning("只收 .ai 稿件。")}
        >
          <span className="upload-well-btn">{ai ? "更换平面稿" : "选取平面稿"}</span>
        </UploadWell>
      </div>
    </section>
  );
}

export function MockupJobPage({
  jobId,
  canCreate,
  canConfirmStructure,
  canAdmin = false,
  onBack,
}: JobProps & { canCreate: boolean; canConfirmStructure: boolean; canAdmin?: boolean }) {
  const { message } = App.useApp();
  const [job, setJob] = useState<MockupJob | null>(() => mockupHandoffFor(jobId));
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState("");
  const [glbFs, setGlbFs] = useState(false);
  const [productLight, setProductLight] = useState(STUDIO_LIGHT_DEFAULT);
  const [backgroundLight, setBackgroundLight] = useState(STUDIO_LIGHT_DEFAULT);
  const [retrying, setRetrying] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [lightsOpen, setLightsOpen] = useState(false);
  const [backdrop, setBackdrop] = useState<BackdropPreset>(readBackdropPreset);
  const [highlightedReadFace, setHighlightedReadFace] = useState<string | null>(null);
  const glbBox = useRef<HTMLDivElement>(null);
  const hudTimer = useRef<number | null>(null);
  const announced = useRef("");
  const fullUpgradeHud = useRef("");
  const lastGlbFs = useRef(false);
  const seededJobId = useRef(jobId);
  const waiting = Boolean(job) && shouldShowWaitCard(job);
  const repairPending = job?.print_faces_repair?.status === "queued" || job?.print_faces_repair?.status === "running";
  const generation=job?.current_render_generation_id || job?.studio_relit_at || job?.job_finished_at || "";
  const visibleGeneration=useRef(generation);
  visibleGeneration.current=generation;
  const sourceErrorGeneration=useRef<string | null>(null);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>()=>releaseStudioGeneration(jobId,generation),[jobId,generation]);
  useEffect(()=>{fullUpgradeHud.current="";},[generation]);

  function refreshSource() {
    if (sourceErrorGeneration.current === generation) return;
    sourceErrorGeneration.current=generation;
    void api.refreshMockup(jobId).then(next=>{
      if (alive.current && visibleGeneration.current === generation) { setJob(next);notice(next.current_render_generation_id !== generation ? "当前版本已变化，已刷新图片" : "版本图片暂时读不到，请重新打开此单"); }
    }).catch(()=>{if(alive.current && visibleGeneration.current === generation)notice("版本图片暂时读不到，未改动当前版本");});
  }

  function notice(text: string, source: HudNoticeSource = "auto") {
    if (text === FULL_UPGRADE_NOTICE) {
      if (!allowFullUpgradeNotice(fullUpgradeHud.current, generation, source)) return;
      fullUpgradeHud.current = generation;
    }
    setHud(text);
    if (hudTimer.current != null) window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(""), HUD_MS);
  }

  async function retry() {
    if (!job || retrying) return;
    setRetrying(true);
    try {
      const next = await api.retryMockup(job.id);
      setError(null);
      setJob(next);
      message.success("已用机上的稿重新排队。");
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : "重试失败");
    } finally {
      setRetrying(false);
    }
  }

  async function repairPrintFaces() {
    if (!job || repairing || repairPending) return;
    setRepairing(true);
    notice("正在补印刷面");
    try {
      const next = await api.repairMockupPrintFaces(job.id);
      setError(null);
      setJob(next);
      notice(next.print_faces_repair?.status === "queued" || next.print_faces_repair?.status === "running"
        ? "补印刷面已排队，可以离开此页" : "印刷面已补上");
    } catch (err: unknown) {
      const status = err instanceof ApiError ? err.status : 0;
      notice("");
      message.error(
        status === 404
          ? "这版还不能补切面"
          : err instanceof Error
            ? err.message
            : "补印刷面失败",
      );
    } finally {
      setRepairing(false);
    }
  }

  useEffect(() => {
    return () => {
      if (hudTimer.current != null) window.clearTimeout(hudTimer.current);
      if (isElementFullscreen(glbBox.current)) void exitElementFullscreen().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    function onFs() {
      const el = glbBox.current;
      const on = isElementFullscreen(el);
      setGlbFs(on);
      if (on === lastGlbFs.current) return;
      lastGlbFs.current = on;
      if (el) pingViewerAfterFullscreen(el);
    }
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (seededJobId.current !== jobId) {
      seededJobId.current = jobId;
      setJob(mockupHandoffFor(jobId));
    }
    setError(null);
    announced.current = "";
    void api
      .mockup(jobId)
      .then((next) => {
        if (cancelled) return;
        setError(null);
        forgetMockupHandoff(jobId);
        setJob(next);
        announced.current = `${next.id}:${next.status}`;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          forgetMockupHandoff(jobId);
          setJob(null);
        }
        setError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (!job?.id || (!waiting && !repairPending)) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      void api
        .mockup(job.id)
        .then((next) => {
          if (cancelled) return;
          setError(null);
          setJob(next);
          if (repairPending) {
            if (next.print_faces_repair?.status === "failed") notice(next.print_faces_repair.error || "补印刷面失败，请重试");
            else if (next.print_faces_repair?.status === "succeeded") notice("印刷面已补上");
            return;
          }
          if (shouldShowWaitCard(next)) return;
          const key = `${next.id}:${next.status}`;
          if (announced.current === key) return;
          announced.current = key;
          if (next.status === "failed") message.error(mockupFailReason(next.error || next.job_error));
          else if (next.status === "done") message.success("打样完成。白底给备案，GLB 看形，下面印刷面读字。");
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 404) {
            forgetMockupHandoff(job.id);
            setJob(null);
          }
          setError(err instanceof Error ? err.message : "打样单读不到");
        });
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [job?.id, waiting, repairPending, message]);

  if (error && !job) {
    return (
      <section>
        <header className="page-head">
          <h1 className="page-title">打样单</h1>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
        </header>
        <Alert type="error" showIcon title={error} />
      </section>
    );
  }

  if (!job) {
    return (
      <section>
        <header className="page-head">
          <h1 className="page-title">打样单</h1>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
        </header>
        <div className="desk-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="打开打样单…" />
        </div>
      </section>
    );
  }

  if (waiting) {
    return (
      <section className="mockup-sheet">
        <header className="page-head">
          <div>
            <h1 className="page-title">{mockTitle(job)}</h1>
            <p className="page-lead">打样还在跑。可以回打样台，进度仍在历史记录里。</p>
          </div>
          <div className="mockup-sheet-head-actions">
            {canCreate ? (
              <button type="button" className="btn-ghost" disabled={retrying} onClick={() => void retry()}>
                {retrying ? "正在重试…" : "重试"}
              </button>
            ) : null}
            <button type="button" className="btn-ghost" onClick={onBack}>
              返回打样台
            </button>
          </div>
        </header>
        <WaitCard
          job="打样"
          jobStatus={job.job_status || (job.status === "queued" || job.status === "running" ? job.status : "queued")}
          queueAhead={job.queue_ahead}
          stage={job.job_stage}
          stageLabel={job.job_stage_label}
          etaS={job.job_eta_s}
        />
      </section>
    );
  }

  if (job.structure_status === "review_required" || job.structure_status === "unsupported") {
    return (
      <section className="mockup-sheet is-structure-confirm">
        <header className="page-head">
          <div>
            <h1 className="page-title">{mockTitle(job)}</h1>
            <p className="page-lead">
              {canAdmin && job.structure_input?.proposal_layers.length
                && !(job.structure_preview?.net_proposals || []).length
                ? `${structureStatusLabel(job)}。先选择真实结构线所在图层，再识别完整盒型。`
                : job.structure_status === "review_required" && (job.structure_preview?.net_proposals || []).length
                  ? "看一下包装展开图，点印有品名的那一面。"
                  : `${structureStatusLabel(job) || "这张稿现在打不了样"}。`}
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
        </header>
        <StructureConfirmPanel
          key={job.id}
          job={job}
          canConfirmStructure={canConfirmStructure}
          canAdmin={canAdmin}
          onConfirmed={setJob}
        />
      </section>
    );
  }

  const whiteA = (job.files || []).find((f) => f.key === "white_a");
  const whiteB = (job.files || []).find((f) => f.key === "white_b");
  const groundA = (job.files || []).find((f) => f.key === "white_a_ground");
  const groundB = (job.files || []).find((f) => f.key === "white_b_ground");
  const hasGlb = (job.files || []).some((f) => f.key === "glb");
  const hasPpt = (job.files || []).some((f) => f.key === "ppt");
  const grounded = jobHasGround(job.files);
  const boundAssetsReady=!job.render_generation_capabilities || Boolean(job.current_render_generation_id);
  const readFaces = listedReadFaces(job.files || []);
  const missingRequired = (["front", "back", "left", "right"] as const).filter((role) => !readFaces.includes(role));
  const canRepairPrint = Boolean(job.can_repair_print_faces);
  const repairFailed = job.print_faces_repair?.status === "failed";
  const showPrintAlert = job.status === "done" && (missingRequired.length > 0 || repairPending || repairFailed);
  const printAlertCopy = repairFailed ? "补印刷面失败，请重试。" : canRepairPrint && canCreate
    ? "缺少印刷面图。可从已保存底稿补生成，不会重新打样。"
    : canCreate
      ? "这单没有可用底稿，无法补生成。请重新打样。"
      : "这单没有印刷面图。请联系能打样的人补或重打。";

  return (
    <section className="mockup-sheet">
      <header className="page-head">
        <div>
          <h1 className="page-title">{mockTitle(job)}</h1>
          <p className="page-lead">打样单。上面三张看形；下面印刷面读字。不要用 GLB 读小字。</p>
        </div>
        <div className="mockup-sheet-head-actions">
          <button
            type="button"
            className="btn-ghost"
            aria-expanded={lightsOpen}
            aria-controls="mockup-studio-lights"
            onClick={() => setLightsOpen((open) => !open)}
          >
            {lightsOpen ? "收起调灯" : "调灯"}
          </button>
          {canCreate && job.status === "failed" ? (
            <button type="button" className="btn-ghost" disabled={retrying} onClick={() => void retry()}>
              {retrying ? "正在重试…" : "重试"}
            </button>
          ) : null}
          {job.render_generation_capabilities?.history.allowed ? (
            <button type="button" className="btn-ghost" aria-expanded={versionsOpen} aria-controls="mockup-render-versions" onClick={()=>setVersionsOpen(value=>!value)}>
              {versionsOpen ? "收起版本" : "出图版本"}
            </button>
          ) : null}
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
          {grounded ? null : hasPpt ? (
            <a
              className="btn-ghost"
              href={fileHref(job.id, "ppt", true)}
              download
              onClick={() => notice(downloadHudLine("PPT"))}
            >
              下载 PPT
            </a>
          ) : grounded ? null : (
            <button type="button" className="btn-ghost" onClick={() => notice(missingPptHud())}>
              下载 PPT
            </button>
          )}
        </div>
      </header>
      {error ? <p className="page-lead" role="status">{error}，当前图片仍保留。</p> : null}
      {job.render_generation_capabilities ? <RenderVersions key={job.id} job={job} open={versionsOpen}
        productLight={productLight} backgroundLight={backgroundLight} onJob={setJob} /> : null}
      <div className="mockup-backdrop-switch">
        <span className="mockup-backdrop-label" id="mockup-backdrop-label">
          背景
        </span>
        <Segmented
          aria-labelledby="mockup-backdrop-label"
          options={BACKDROP_PRESETS.map((preset) => ({
            label: BACKDROP_LABEL[preset],
            value: preset,
          }))}
          value={backdrop}
          onChange={(value) => {
            const next = parseBackdropPreset(value);
            setBackdrop(next);
            writeBackdropPreset(next);
          }}
        />
      </div>
      {lightsOpen ? (
        <div id="mockup-studio-lights">
          <StudioLightSliders
            productLight={productLight}
            backgroundLight={backgroundLight}
            onProductLight={setProductLight}
            onBackgroundLight={setBackgroundLight}
          />
        </div>
      ) : null}

      {job.status === "failed" ? (
        <Alert type="error" showIcon title={mockupFailReason(job.error || job.job_error)} />
      ) : null}

      {canAdmin && !repairPending && job.status === "done" && !job.has_render_generations && !job.render_mutation ? (
        <AdminRotateFront job={job} onConfirmed={setJob} />
      ) : null}

      {showPrintAlert ? (
        <div className="mockup-print-alert" role="status" aria-live="polite">
          <p className="mockup-print-alert-copy">
            {repairPending ? (job.print_faces_repair?.status === "queued" ? "补印刷面已排队，可以离开此页" : "正在补印刷面，可以离开此页")
              : repairing ? "正在提交补面请求" : job.print_faces_repair?.error || printAlertCopy}
          </p>
          {canRepairPrint && canCreate ? (
            <button
              type="button"
              className="btn-ghost"
              disabled={repairing || repairPending}
              aria-busy={repairing || repairPending || undefined}
              onClick={() => void repairPrintFaces()}
            >
              {repairing || repairPending ? "正在补印刷面" : "补印刷面"}
            </button>
          ) : null}
        </div>
      ) : null}

      {!boundAssetsReady ? <p className="page-lead" role="status">当前版本资源尚未确认，未混用其他版本的图片。</p> : <div key={`${job.id}:${generation}`} data-render-generation={generation} className={grounded ? "mockup-sheet-photos is-grounded" : "mockup-sheet-photos"}>
        {groundA && whiteA ? (
          <GroundedShot
            generation={generation}
            onSourceError={refreshSource}
            jobId={job.id}
            files={job.files}
            fileKey="white_a"
            groundKey="white_a_ground"
            alt="正面与侧面成片"
            caption="正面 + 侧面"
            downloadName={whiteA.name}
            productLight={productLight}
            backgroundLight={backgroundLight}
            backdrop={backdrop}
            onProductLight={setProductLight}
            onBackgroundLight={setBackgroundLight}
            onDownload={() => notice(downloadHudLine("成片"))}
            onError={() => notice("导出失败")}
            onNotice={notice}
          />
        ) : whiteA ? (
          <WhiteShot
            key={`${job.id}:${generation}:white_a`}
            generation={generation}
            onSourceError={refreshSource}
            jobId={job.id}
            fileKey="white_a"
            alt="正面与侧面白底"
            caption="正面 + 侧面"
            downloadName={whiteA.name}
            productLight={productLight}
            backgroundLight={backgroundLight}
            backdrop={backdrop}
            onProductLight={setProductLight}
            onBackgroundLight={setBackgroundLight}
            onDownload={() => notice(downloadHudLine("白底"))}
          />
        ) : (
          <figure className="mockup-sheet-photo">
            <div
              className={`mockup-sheet-frame${grounded ? " is-studio-ground" : ""} ${backdropFrameClass(backdrop)}`}
              style={{ background: studioBackdrop(backgroundLight, backdrop) }}
            >
              <p className="page-lead">还没有正面+侧面。</p>
            </div>
            <figcaption className="mockup-sheet-cap">正面 + 侧面</figcaption>
          </figure>
        )}
        {groundB && whiteB ? (
          <GroundedShot
            generation={generation}
            onSourceError={refreshSource}
            jobId={job.id}
            files={job.files}
            fileKey="white_b"
            groundKey="white_b_ground"
            alt="反面与侧面成片"
            caption="反面 + 侧面"
            downloadName={whiteB.name}
            productLight={productLight}
            backgroundLight={backgroundLight}
            backdrop={backdrop}
            onProductLight={setProductLight}
            onBackgroundLight={setBackgroundLight}
            onDownload={() => notice(downloadHudLine("成片"))}
            onError={() => notice("导出失败")}
            onNotice={notice}
          />
        ) : whiteB ? (
          <WhiteShot
            key={`${job.id}:${generation}:white_b`}
            generation={generation}
            onSourceError={refreshSource}
            jobId={job.id}
            fileKey="white_b"
            alt="反面与侧面白底"
            caption="反面 + 侧面"
            downloadName={whiteB.name}
            productLight={productLight}
            backgroundLight={backgroundLight}
            backdrop={backdrop}
            onProductLight={setProductLight}
            onBackgroundLight={setBackgroundLight}
            onDownload={() => notice(downloadHudLine("白底"))}
          />
        ) : (
          <figure className="mockup-sheet-photo">
            <div
              className={`mockup-sheet-frame${grounded ? " is-studio-ground" : ""} ${backdropFrameClass(backdrop)}`}
              style={{ background: studioBackdrop(backgroundLight, backdrop) }}
            >
              <p className="page-lead">还没有反面+侧面。</p>
            </div>
            <figcaption className="mockup-sheet-cap">反面 + 侧面</figcaption>
          </figure>
        )}
        {hasGlb ? (
          <GlbShot
            jobId={job.id}
            generation={generation}
            onSourceError={refreshSource}
            boxRef={glbBox}
            backgroundLight={backgroundLight}
            productLight={productLight}
            backdrop={backdrop}
            glbFs={glbFs}
            onNotice={notice}
          />
        ) : (
          <figure className="mockup-sheet-photo">
            <div className="mockup-sheet-frame">
              <Empty description={job.status === "done" ? "没有立体模型" : "GLB 还没出"} />
            </div>
            <figcaption className="mockup-sheet-cap">GLB</figcaption>
          </figure>
        )}
      </div>}
      {readFaces.length ? (
        <div className="mockup-read-chips" role="navigation" aria-label="跳到印刷面">
          <span className="mockup-backdrop-label">读字</span>
          {readFaces.map((role) => (
            <button
              key={role}
              type="button"
              className={highlightedReadFace === role ? "mockup-read-chip is-current" : "mockup-read-chip"}
              onClick={() => {
                setHighlightedReadFace(role);
                document.getElementById(`read-face-${role}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              {READ_FACE_LABEL[role]}
            </button>
          ))}
        </div>
      ) : null}
      <section className="mockup-read-faces" aria-label="印刷面读字">
        <h2 className="mockup-read-title">读字</h2>
        <p className="page-lead">印刷面来自打样时已生成的各面图，不是 3D 截屏。滚轮或按钮可放到 6 倍。</p>
        {readFaces.length ? (
          <div className="mockup-read-grid">
            {readFaces.map((role) => {
              const fileKey = readFaceKey(role);
              const file = (job.files || []).find((item) => item.key === fileKey);
              return (
                <ReadFaceShot
                  key={fileKey}
                  jobId={job.id}
                  fileKey={fileKey}
                  label={READ_FACE_LABEL[role]}
                  highlighted={highlightedReadFace === role}
                  faceId={`read-face-${role}`}
                  downloadName={file?.name}
                  onDownload={() => notice(downloadHudLine("印刷面"))}
                />
              );
            })}
          </div>
        ) : showPrintAlert ? null : (
          <p className="page-lead">这单没有印刷面图。要读字请重新打样。</p>
        )}
      </section>
      {hud && typeof document !== "undefined"
        ? createPortal(
            <p className="mockup-hud" role="status" aria-live="polite">
              {hud}
            </p>,
            document.body,
          )
        : null}
    </section>
  );
}

function ReadFaceShot({
  jobId,
  fileKey,
  label,
  downloadName,
  highlighted,
  faceId,
  onDownload,
}: {
  jobId: string;
  fileKey: string;
  label: string;
  downloadName?: string;
  highlighted?: boolean;
  faceId?: string;
  onDownload: () => void;
}) {
  const [bad, setBad] = useState(false);
  const [zoom, setZoom] = useState(resetZoom);
  const viewRef = useRef<HTMLDivElement>(null);
  const zoomElRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomState>(zoom);
  const panDrag = useRef<{ x: number; y: number } | null>(null);
  const panRaf = useRef<number | null>(null);
  const wheelEnd = useRef<number | null>(null);
  zoomRef.current = zoom;

  const paintZoom = (next: ZoomState) => {
    const el = zoomElRef.current;
    if (el) el.style.transform = zoomCss(next);
  };

  const commitZoom = (next: ZoomState) => {
    zoomRef.current = next;
    paintZoom(next);
    setZoom(next);
  };

  const zoomFromCenter = (nextScale: number) => {
    const view = viewRef.current;
    const ox = view ? view.clientWidth / 2 : 0;
    const oy = view ? view.clientHeight / 2 : 0;
    commitZoom(zoomAt(zoomRef.current, nextScale, ox, oy));
  };

  useEffect(() => {
    const el = viewRef.current;
    if (!el || bad) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomRef.current = zoomAt(
        zoomRef.current,
        zoomRef.current.scale * factor,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      if (panRaf.current == null) {
        panRaf.current = window.requestAnimationFrame(() => {
          panRaf.current = null;
          paintZoom(zoomRef.current);
        });
      }
      if (wheelEnd.current != null) window.clearTimeout(wheelEnd.current);
      wheelEnd.current = window.setTimeout(() => {
        wheelEnd.current = null;
        setZoom(zoomRef.current);
      }, 80);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelEnd.current != null) window.clearTimeout(wheelEnd.current);
    };
  }, [bad]);

  const endPan = (target: HTMLElement) => {
    panDrag.current = null;
    target.classList.remove("is-panning");
    setZoom(zoomRef.current);
  };

  return (
    <figure className={highlighted ? "mockup-read-face is-highlight" : "mockup-read-face"} id={faceId}>
      <div
        className="mockup-read-frame"
        ref={viewRef}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 0 || bad) return;
          if ((event.target as HTMLElement).closest("button, a")) return;
          event.preventDefault();
          panDrag.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.classList.add("is-panning");
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = panDrag.current;
          if (!drag) return;
          event.preventDefault();
          const next = panBy(zoomRef.current, event.clientX - drag.x, event.clientY - drag.y);
          drag.x = event.clientX;
          drag.y = event.clientY;
          zoomRef.current = next;
          if (panRaf.current == null) {
            panRaf.current = window.requestAnimationFrame(() => {
              panRaf.current = null;
              paintZoom(zoomRef.current);
            });
          }
        }}
        onPointerUp={(event) => endPan(event.currentTarget)}
        onPointerCancel={(event) => endPan(event.currentTarget)}
        onLostPointerCapture={(event) => endPan(event.currentTarget)}
      >
        {bad ? (
          <p className="page-lead">这张印刷面图坏了，重新打样后才能读字。</p>
        ) : (
          <div className="mockup-read-zoom" ref={zoomElRef} style={{ transform: zoomCss(zoom) }}>
            <img
              src={fileHref(jobId, fileKey)}
              alt={`${label}印刷面`}
              loading="lazy"
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              onError={() => setBad(true)}
            />
          </div>
        )}
        {bad ? null : (
          <>
            <div className="mockup-read-tools">
              <button
                type="button"
                className="mockup-dl"
                aria-label={`缩小${label}印刷面`}
                onClick={() => zoomFromCenter(zoomRef.current.scale / 1.25)}
              >
                缩小
              </button>
              <button
                type="button"
                className="mockup-dl"
                aria-label={`恢复${label}印刷面 1 倍`}
                onClick={() => commitZoom(resetZoom())}
              >
                1×
              </button>
              <button
                type="button"
                className="mockup-dl"
                aria-label={`放大${label}印刷面`}
                onClick={() => zoomFromCenter(zoomRef.current.scale * 1.25)}
              >
                放大
              </button>
            </div>
            <a
              className="mockup-dl mockup-dl-fs"
              href={fileHref(jobId, fileKey)}
              target="_blank"
              rel="noreferrer"
              aria-label={`打开${label}印刷面`}
            >
              原图
            </a>
            <a
              className="mockup-dl mockup-dl-corner"
              href={fileHref(jobId, fileKey, true)}
              download={downloadName}
              aria-label={`下载${label}印刷面`}
              onClick={onDownload}
            >
              下载
            </a>
          </>
        )}
      </div>
      <figcaption className="mockup-sheet-cap">{label}</figcaption>
    </figure>
  );
}

function GlbShot({
  jobId,
  generation,
  onSourceError,
  boxRef,
  backgroundLight,
  productLight,
  backdrop,
  glbFs,
  onNotice,
}: {
  jobId: string;
  generation:string;
  onSourceError:()=>void;
  boxRef: { current: HTMLDivElement | null };
  backgroundLight: number;
  productLight: number;
  backdrop: BackdropPreset;
  glbFs: boolean;
  onNotice: (text: string) => void;
}) {
  const fill = studioBackdrop(backgroundLight, backdrop);
  return (
    <figure className="mockup-sheet-photo">
      <div
        className={`mockup-sheet-frame mockup-sheet-glb ${backdropFrameClass(backdrop)}`}
        ref={boxRef}
        style={{ background: fill }}
      >
        <model-viewer
          src={fileHref(jobId, "glb",false,generation)}
          onError={onSourceError}
          camera-controls
          environment-image="neutral"
          exposure={glbExposure(productLight)}
          shadow-intensity="1"
          shadow-softness="0.25"
          tone-mapping="commerce"
          interaction-prompt="none"
          style={{
            background: fill,
            ["--poster-color" as string]: fill,
          }}
        />
        <button
          type="button"
          className="mockup-dl mockup-dl-fs"
          aria-label={glbFs ? "退出全屏" : "全屏截图"}
          onClick={() => {
            const el = boxRef.current;
            if (!el) return;
            if (isElementFullscreen(el)) {
              void exitElementFullscreen().catch(() => undefined);
              return;
            }
            void enterElementFullscreen(el).catch(() => onNotice("全屏打不开"));
          }}
        >
          {glbFs ? "退出" : "全屏"}
        </button>
        <a
          className="mockup-dl mockup-dl-corner"
          href={fileHref(jobId, "glb", true,generation)}
          download
          aria-label="下载 GLB"
          onClick={() => onNotice(downloadHudLine("GLB"))}
        >
          下载
        </a>
      </div>
      <figcaption className="mockup-sheet-cap">GLB</figcaption>
    </figure>
  );
}

type PreviewSource = CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };

function useReleasedCanvasRef() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const setCanvasRef = useCallback((node: HTMLCanvasElement | null) => {
    if (canvasRef.current && canvasRef.current !== node) releaseCanvasBacking(canvasRef.current);
    canvasRef.current = node;
  }, []);
  return [canvasRef, setCanvasRef] as const;
}

function GroundedShot({
  generation,
  onSourceError,
  jobId,
  files,
  fileKey,
  groundKey,
  alt,
  caption,
  downloadName,
  productLight,
  backgroundLight,
  backdrop,
  onProductLight,
  onBackgroundLight,
  onDownload,
  onError,
  onNotice,
  lazy,
}: {
  generation: string;
  onSourceError:()=>void;
  jobId: string;
  files?: Array<{ key: string }>;
  fileKey: "white_a" | "white_b";
  groundKey: "white_a_ground" | "white_b_ground";
  alt: string;
  caption: string;
  downloadName?: string;
  productLight: number;
  backgroundLight: number;
  backdrop: BackdropPreset;
  onProductLight: (value: number) => void;
  onBackgroundLight: (value: number) => void;
  onDownload: () => void;
  onError: () => void;
  onNotice: (text: string, source?: HudNoticeSource) => void;
  lazy?: boolean;
}) {
  const [bad, setBad] = useState(false);
  const [ready, setReady] = useState(0);
  const [frameSize, setFrameSize] = useState<[number, number]>([0, 0]);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [visible, setVisible] = useState(!lazy);
  const [canvasRef, setCanvasRef] = useReleasedCanvasRef();
  const frameRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<StudioPreviewSources | null>(null);
  const lightboxSourcesRef = useRef<{ product: PreviewSource; ground: PreviewSource; set: PreviewSource | null } | null>(null);
  const exporting = useRef(false);
  const noticedUpgrade = useRef("");
  const sourceIdentity = `${jobId}:${generation}:${fileKey}:${groundKey}:${(files || []).map((file) => file.key).sort().join(",")}`;

  useEffect(() => {
    setBad(false);
    setOriginalOpen(false);
    setReady(0);
    previewRef.current = null;
    noticedUpgrade.current = "";
    if (canvasRef.current) {
      releaseCanvasBacking(canvasRef.current);
      applyStudioPreviewDataset(canvasRef.current, null, backdrop, null);
    }
  }, [sourceIdentity]);

  useEffect(() => {
    if (!visible || bad || !frameRef.current) return;
    return observeStudioFrame(frameRef.current, (width, height) => setFrameSize([width, height]));
  }, [visible, bad]);

  useEffect(() => {
    if (!lazy || visible) return;
    const node = frameRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [lazy, visible]);

  useEffect(() => {
    if (!visible || bad) return;
    setReady(0);
    const urls = (key: "white_a" | "white_b" | "white_a_ground" | "white_b_ground" | "white_a_set" | "white_b_set") => ({
      full: fileHref(jobId, key, false, generation),
      card: jobHasReviewCard(files, key) ? fileHref(jobId, reviewCardKey(key), false, generation) : undefined,
    });
    const cancel = loadStudioPreview({
      product: urls(fileKey), ground: urls(groundKey),
      set: jobHasSet(files, fileKey) ? urls(stillSetKey(fileKey)) : null,
    }, (sources) => {
      previewRef.current = sources;
      setReady((value) => value + 1);
    }, () => {setBad(true);onSourceError();});
    return () => {
      cancel();
      previewRef.current = null;
    };
  }, [visible, bad, sourceIdentity]);

  useEffect(() => {
    if (!visible || bad || !ready) return;
    const canvas = canvasRef.current;
    const sources = previewRef.current;
    if (!canvas || !sources || !frameSize[0] || !frameSize[1]) return;
    const ctx = prepareStudioCanvas(canvas, frameSize[0], frameSize[1]);
    if (!ctx) { setBad(true); applyStudioPreviewDataset(canvas, null, backdrop, null); return; }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
    composeStudioStill(ctx, canvas.width, canvas.height, sources.product, sources.ground, {
      productLight,
      backgroundLight,
      backdrop,
      set: sources.set,
      filterSupported: canvasFilterSupported(ctx),
    });
    applyStudioPreviewDataset(canvas, sources.facts, backdrop, sources.set);
    if (typeof window !== "undefined" && (window as Window & { __RF09_PERF__?: boolean }).__RF09_PERF__
      && typeof performance !== "undefined" && typeof performance.mark === "function") {
      if (performance.getEntriesByName("rf09-composed", "mark").length >= 24) performance.clearMarks("rf09-composed");
      performance.mark("rf09-composed");
    }
    if (studioDrawnUpgradeFailed(sources.facts, backdrop, sources.set) && noticedUpgrade.current !== sourceIdentity) {
      noticedUpgrade.current = sourceIdentity;
      onNotice(FULL_UPGRADE_NOTICE);
    }
    } catch { ctx.clearRect(0, 0, canvas.width, canvas.height); applyStudioPreviewDataset(canvas, null, backdrop, null); setBad(true); }
  }, [visible, bad, ready, frameSize, productLight, backgroundLight, backdrop]);

  useEffect(() => {
    if (!originalOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOriginalOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [originalOpen]);

  async function saveLit() {
    if (!ready || exporting.current) return;
    exporting.current = true;
    try {
      const frozenGeneration = generation;
      const frozenBackdrop = backdrop;
      const frozenProductLight = productLight;
      const frozenBackgroundLight = backgroundLight;
      const frozenPreview = previewRef.current;
      const frozenSources = (originalOpen ? lightboxSourcesRef.current : null) ?? frozenPreview;
      const frozenSet = frozenSources?.set ?? null;
      const setKey = stillSetKey(fileKey);
      const needGround = frozenBackdrop === "white_set";
      const productP = loadStillImage(fileHref(jobId, fileKey, false, frozenGeneration));
      const groundP = needGround
        ? loadStillImage(fileHref(jobId, groundKey, false, frozenGeneration))
        : Promise.resolve(null);
      const required = Promise.all([productP, groundP]);
      required.catch(() => undefined);
      let product: HTMLImageElement;
      let ground: HTMLImageElement | null;
      let setImage: HTMLImageElement | null = null;
      if (studioDrawnLayerKeys(frozenBackdrop, frozenSet).keys.includes("set")) {
        const setP = loadStillImage(fileHref(jobId, setKey, false, frozenGeneration));
        setP.catch(() => undefined);
        const peeked = await peekSettled(setP);
        const setFull = peeked.status === "fulfilled" ? "ready" : peeked.status === "rejected" ? "failed" : "pending";
        const decided = planStudioExport(frozenBackdrop, frozenSet, setFull);
        if (decided.action === "defer-set-full") {
          onNotice(FULL_UPGRADE_NOTICE, "action");
          return;
        }
        const pair = await required;
        product = pair[0];
        ground = pair[1];
        setImage = peeked.status === "fulfilled" ? peeked.value : null;
      } else {
        const pair = await required;
        product = pair[0];
        ground = pair[1];
      }
      const blob = await blobFromStudioStill(product, ground, {
        productLight: frozenProductLight,
        backgroundLight: frozenBackgroundLight,
        backdrop: frozenBackdrop,
        set: setImage,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName || `${caption}.png`;
      link.click();
      URL.revokeObjectURL(url);
      onDownload();
    } catch {
      onError();
    } finally {
      exporting.current = false;
    }
  }

  return (
    <figure className="mockup-sheet-photo">
      <div
        className={`mockup-sheet-frame is-studio-ground ${backdropFrameClass(backdrop)}`}
        ref={frameRef}
        style={{ background: studioBackdrop(backgroundLight, backdrop) }}
      >
        {bad ? (
          <p className="page-lead">这张白底图坏了，回到打样台重新打。</p>
        ) : (
          <canvas ref={setCanvasRef} className="mockup-studio-canvas" aria-label={alt} />
        )}
        {bad ? null : (
          <>
            <button
              type="button"
              className="mockup-dl mockup-dl-fs"
              aria-label={`打开${caption}原图`}
              onClick={() => setOriginalOpen(true)}
            >
              原图
            </button>
            <button
              type="button"
              className="mockup-dl mockup-dl-corner"
              aria-label={`下载${caption}`}
              disabled={!ready}
              onClick={() => void saveLit()}
            >
              下载
            </button>
          </>
        )}
      </div>
      <figcaption className="mockup-sheet-cap">{caption}</figcaption>
      {originalOpen && !bad
        ? createPortal(
            <div
              className="mockup-still-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`${caption}原图`}
              onClick={() => setOriginalOpen(false)}
            >
              <div className="mockup-still-lightbox-panel" onClick={(event) => event.stopPropagation()}>
                <div
                  className={`mockup-still-lightbox-stage is-studio-ground ${backdropFrameClass(backdrop)}`}
                  style={{ background: studioBackdrop(backgroundLight, backdrop) }}
                >
                  <GroundedLightboxStill
                    generation={generation}
                    jobId={jobId}
                    files={files}
                    fileKey={fileKey}
                    groundKey={groundKey}
                    alt={alt}
                    productLight={productLight}
                    backgroundLight={backgroundLight}
                    backdrop={backdrop}
                    sourcesOut={lightboxSourcesRef}
                    placeholder={previewRef.current ? { product: previewRef.current.product, ground: previewRef.current.ground, set: previewRef.current.set } : null}
                  />
                </div>
                <StudioLightSliders
                  productLight={productLight}
                  backgroundLight={backgroundLight}
                  onProductLight={onProductLight}
                  onBackgroundLight={onBackgroundLight}
                />
                <div className="mockup-still-lightbox-actions">
                  <button type="button" className="mockup-dl" disabled={!ready} onClick={() => void saveLit()}>
                    下载
                  </button>
                  <button type="button" className="mockup-dl" onClick={() => setOriginalOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </figure>
  );
}

function GroundedLightboxStill({
  generation,
  jobId,
  files,
  fileKey,
  groundKey,
  alt,
  productLight,
  backgroundLight,
  backdrop,
  placeholder,
  sourcesOut,
}: {
  generation: string;
  jobId: string;
  files?: Array<{ key: string }>;
  fileKey: "white_a" | "white_b";
  groundKey: "white_a_ground" | "white_b_ground";
  alt: string;
  productLight: number;
  backgroundLight: number;
  backdrop: BackdropPreset;
  placeholder?: { product: PreviewSource; ground: PreviewSource; set: PreviewSource | null } | null;
  sourcesOut?: { current: { product: PreviewSource; ground: PreviewSource; set: PreviewSource | null } | null };
}) {
  const [canvasRef, setCanvasRef] = useReleasedCanvasRef();
  const sourcesRef = useRef<{ product: PreviewSource; ground: PreviewSource; set: PreviewSource | null } | null>(
    placeholder || null,
  );
  const [loaded, setLoaded] = useState(placeholder ? 1 : 0);
  const [paintError, setPaintError] = useState(false);
  function publishSources(next: { product: PreviewSource; ground: PreviewSource; set: PreviewSource | null } | null) {
    sourcesRef.current = next;
    if (sourcesOut) sourcesOut.current = next;
  }
  useEffect(() => {
    const seed = placeholder ?? null;
    publishSources(seed);
    setLoaded(seed ? 1 : 0);
    setPaintError(false);
    const seedSet = seed?.set ?? null;
    let cancelled = false;
    void (async () => {
      try {
        const setKey = stillSetKey(fileKey);
        const productP = loadStillImage(fileHref(jobId, fileKey, false, generation));
        const groundP = loadStillImage(fileHref(jobId, groundKey, false, generation));
        const setP = jobHasSet(files, fileKey)
          ? loadStillImage(fileHref(jobId, setKey, false, generation))
          : Promise.resolve(null);
        const required = Promise.all([productP, groundP]);
        required.catch(() => undefined);
        setP.catch(() => undefined);
        const [product, ground] = await required;
        if (cancelled) return;
        publishSources({ product, ground, set: seedSet });
        setLoaded((n) => n + 1);
        try {
          const set = await setP;
          if (cancelled) return;
          publishSources({ product, ground, set });
          setLoaded((n) => n + 1);
        } catch {
          /* keep the shown set card; do not swap in ground-only */
        }
      } catch {
        /* lightbox keeps the card placeholder or STUDIO_GROUND_FILL stage */
      }
    })();
    return () => {
      cancelled = true;
      if (canvasRef.current) releaseCanvasBacking(canvasRef.current);
    };
  }, [jobId, generation, files, fileKey, groundKey]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const sources = sourcesRef.current;
    if (!canvas || !sources || !loaded) return;
    const ctx = prepareStudioCanvas(
      canvas,
      Number(sources.product.naturalWidth || sources.product.width || 0),
      Number(sources.product.naturalHeight || sources.product.height || 0),
    );
    if (!ctx) return;
    try {
    composeStudioStill(ctx, canvas.width, canvas.height, sources.product, sources.ground, {
      productLight,
      backgroundLight,
      backdrop,
      set: sources.set,
      filterSupported: canvasFilterSupported(ctx),
    });
    setPaintError(false);
    } catch { ctx.clearRect(0, 0, canvas.width, canvas.height); setPaintError(true); }
  }, [loaded, productLight, backgroundLight, backdrop, jobId, generation]);
  return <>{paintError ? <p className="page-lead">调灯失败，请重新加载图片。</p> : null}<canvas ref={setCanvasRef} className="mockup-studio-lightbox-canvas" aria-label={alt} /></>;
}

function StudioLightSliders({
  productLight,
  backgroundLight,
  onProductLight,
  onBackgroundLight,
}: {
  productLight: number;
  backgroundLight: number;
  onProductLight: (value: number) => void;
  onBackgroundLight: (value: number) => void;
}) {
  return (
    <div className="mockup-studio-lights">
      <label className="mockup-studio-light">
        产品灯光
        <input
          aria-label="产品灯光"
          aria-valuemax={STUDIO_LIGHT_MAX}
          aria-valuemin={STUDIO_LIGHT_MIN}
          aria-valuenow={productLight}
          max={STUDIO_LIGHT_MAX}
          min={STUDIO_LIGHT_MIN}
          onChange={(event) => onProductLight(clampStudioLight(Number(event.target.value)))}
          step={0.02}
          type="range"
          value={productLight}
        />
      </label>
      <label className="mockup-studio-light">
        背景灯光
        <input
          aria-label="背景灯光"
          aria-valuemax={STUDIO_LIGHT_MAX}
          aria-valuemin={STUDIO_LIGHT_MIN}
          aria-valuenow={backgroundLight}
          max={STUDIO_LIGHT_MAX}
          min={STUDIO_LIGHT_MIN}
          onChange={(event) => onBackgroundLight(clampStudioLight(Number(event.target.value)))}
          step={0.02}
          type="range"
          value={backgroundLight}
        />
      </label>
    </div>
  );
}

function WhiteShot({
  generation,
  onSourceError,
  jobId,
  fileKey,
  alt,
  caption,
  downloadName,
  productLight,
  backgroundLight,
  backdrop,
  onProductLight,
  onBackgroundLight,
  onDownload,
}: {
  generation: string;
  onSourceError:()=>void;
  jobId: string;
  fileKey: "white_a" | "white_b";
  alt: string;
  caption: string;
  downloadName?: string;
  productLight: number;
  backgroundLight: number;
  backdrop: BackdropPreset;
  onProductLight: (value: number) => void;
  onBackgroundLight: (value: number) => void;
  onDownload: () => void;
}) {
  const [bad, setBad] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imageReady, setImageReady] = useState(false);
  const exporting = useRef(false);
  const fill = studioBackdrop(backgroundLight, backdrop);

  useEffect(() => {
    if (!originalOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOriginalOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [originalOpen]);

  async function saveLit() {
    const img = imgRef.current;
    if (!img || exporting.current) return;
    exporting.current = true;
    try {
      const blob = await blobFromLitStill(img, { productLight, backgroundLight, backdrop });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName || `${caption}.png`;
      link.click();
      URL.revokeObjectURL(url);
      onDownload();
    } catch {
      /* 导出失败不假装已经在下载 */
    } finally {
      exporting.current = false;
    }
  }

  return (
    <figure className="mockup-sheet-photo">
      <div className={`mockup-sheet-frame ${backdropFrameClass(backdrop)}`} style={{ background: fill }}>
        {bad ? (
          <p className="page-lead">这张白底图坏了，回到打样台重新打。</p>
        ) : (
          <>
          <img
            ref={imgRef}
            src={fileHref(jobId, fileKey, false, generation)}
            alt={alt}
            onError={() => {setBad(true);onSourceError();}}
            onLoad={() => setImageReady(true)}
            style={{ display: "none" }}
          />
          {imageReady && imgRef.current ? <LegacyLitCanvas image={imgRef.current} alt={alt} productLight={productLight} backgroundLight={backgroundLight} backdrop={backdrop} /> : null}
          </>
        )}
        {bad ? null : (
          <>
            <button
              type="button"
              className="mockup-dl mockup-dl-fs"
              aria-label={`打开${caption}原图`}
              onClick={() => setOriginalOpen(true)}
            >
              原图
            </button>
            <button
              type="button"
              className="mockup-dl mockup-dl-corner"
              aria-label={`下载${caption}`}
              onClick={() => void saveLit()}
            >
              下载
            </button>
          </>
        )}
      </div>
      <figcaption className="mockup-sheet-cap">{caption}</figcaption>
      {originalOpen && !bad
        ? createPortal(
            <div
              className="mockup-still-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`${caption}原图`}
              onClick={() => setOriginalOpen(false)}
            >
              <div className="mockup-still-lightbox-panel" onClick={(event) => event.stopPropagation()}>
                <div
                  className={`mockup-still-lightbox-stage ${backdropFrameClass(backdrop)}`}
                  style={{ background: fill }}
                >
                  {imageReady && imgRef.current ? <LegacyLitCanvas image={imgRef.current} alt={alt} productLight={productLight} backgroundLight={backgroundLight} backdrop={backdrop} full /> : null}
                </div>
                <StudioLightSliders
                  productLight={productLight}
                  backgroundLight={backgroundLight}
                  onProductLight={onProductLight}
                  onBackgroundLight={onBackgroundLight}
                />
                <div className="mockup-still-lightbox-actions">
                  <button type="button" className="mockup-dl" onClick={() => void saveLit()}>
                    下载
                  </button>
                  <button type="button" className="mockup-dl" onClick={() => setOriginalOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </figure>
  );
}

function LegacyLitCanvas({ image, alt, productLight, backgroundLight, backdrop, full = false }: {
  image: HTMLImageElement; alt: string; productLight: number; backgroundLight: number; backdrop: BackdropPreset; full?: boolean;
}) {
  const [canvasRef, setCanvasRef] = useReleasedCanvasRef();
  const [size, setSize] = useState<[number, number]>([0, 0]);
  const [error, setError] = useState(false);
  useEffect(() => {
    const frame = canvasRef.current?.parentElement;
    if (!frame || full) return;
    return observeStudioFrame(frame, (w, h) => setSize([w, h]));
  }, [full]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const target = canvasBackingSize(
      full ? image.naturalWidth : size[0],
      full ? image.naturalHeight : size[1],
    );
    if (!target.width || !target.height) return;
    const ctx = prepareStudioCanvas(canvas, target.width, target.height);
    if (!ctx) { setError(true); return; }
    try {
      composeStudioStill(ctx, canvas.width, canvas.height, image, null, { productLight, backgroundLight, backdrop, filterSupported: canvasFilterSupported(ctx) });
      setError(false);
    } catch { ctx.clearRect(0, 0, canvas.width, canvas.height); setError(true); }
  }, [image, size, full, productLight, backgroundLight, backdrop]);
  return <>{error ? <p className="page-lead">调灯失败，请重新加载图片。</p> : null}<canvas ref={setCanvasRef} className={full ? "mockup-studio-lightbox-canvas" : "mockup-studio-canvas"} aria-label={alt} /></>;
}
